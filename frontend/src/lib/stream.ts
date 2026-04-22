import { createEffect, createSignal, onCleanup } from 'solid-js'
import type { OrderBook } from './api'

type StreamMsg =
  | { type: 'book'; data: OrderBook & { asset_id: string } }
  | {
      type: 'price_change'
      data: {
        price_changes: {
          asset_id: string
          price: string
          size: string
          side: 'BUY' | 'SELL'
        }[]
      }
    }
  | {
      type: 'last_trade'
      data: {
        asset_id?: string
        price: string
        size: string
        side: 'BUY' | 'SELL'
        fee_rate_bps?: string
        timestamp?: string
      }
    }
  | { type: 'tick_size'; data: { asset_id?: string; new_tick_size: string } }

export type SortedLevel = { price: number; size: number }
export type LastTrade = {
  price: number
  size: number
  side: 'BUY' | 'SELL'
  ts: number
}

export type LiveBook = {
  // Pre-sorted views — bids descending (best first), asks ascending (best first).
  // Avoids per-frame sorting inside the OrderBook component.
  bids: () => SortedLevel[]
  asks: () => SortedLevel[]
  lastTrade: () => LastTrade | null
  connected: () => boolean
  version: () => number
}

/**
 * Subscribe to the backend SSE stream for a specific token.
 *
 * Internals:
 * - Maintains pre-sorted bid/ask arrays in a working copy.
 * - price_change events mutate via binary-search insert/delete (O(log n) + O(n) splice).
 * - Publishes on animation frames only, and only when the version number
 *   has advanced — no wasted signal writes or re-sorts downstream.
 */
export function createLiveBook(tokenId: () => string | undefined): LiveBook {
  const [bids, setBids] = createSignal<SortedLevel[]>([])
  const [asks, setAsks] = createSignal<SortedLevel[]>([])
  const [version, setVersion] = createSignal(0)
  const [lastTrade, setLastTrade] = createSignal<LastTrade | null>(null)
  const [connected, setConnected] = createSignal(false)

  createEffect(() => {
    const tok = tokenId()
    setBids([])
    setAsks([])
    setVersion(0)
    setLastTrade(null)
    setConnected(false)
    if (!tok) return

    // Sorted working copies.
    // Bids: descending (best/highest first). cmpBids returns <0 when a > b.
    // Asks: ascending  (best/lowest  first).
    let workingBids: SortedLevel[] = []
    let workingAsks: SortedLevel[] = []
    let workingVersion = 0
    let publishedVersion = 0
    let lastTradeBuf: LastTrade | null = null
    let rafId: number | null = null
    // Guards against rAF / SSE callbacks still firing after the effect has
    // been disposed (e.g. token change, unmount).
    let disposed = false

    const publish = () => {
      rafId = null
      if (disposed) return
      if (workingVersion === publishedVersion && !lastTradeBuf) return
      if (workingVersion !== publishedVersion) {
        publishedVersion = workingVersion
        setBids(workingBids.slice())
        setAsks(workingAsks.slice())
        setVersion(workingVersion)
      }
      if (lastTradeBuf) {
        setLastTrade(lastTradeBuf)
        lastTradeBuf = null
      }
    }

    const schedule = () => {
      if (disposed) return
      if (rafId == null) rafId = requestAnimationFrame(publish)
    }

    // Binary search — returns the index where `price` belongs under the given
    // direction (descending=true for bids, false for asks).
    const bsearch = (arr: SortedLevel[], price: number, desc: boolean) => {
      let lo = 0
      let hi = arr.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        const cmp = desc ? arr[mid].price > price : arr[mid].price < price
        if (cmp) lo = mid + 1
        else hi = mid
      }
      return lo
    }

    const applyChange = (
      arr: SortedLevel[],
      price: number,
      size: number,
      desc: boolean
    ) => {
      const idx = bsearch(arr, price, desc)
      const hit = idx < arr.length && arr[idx].price === price
      if (size === 0) {
        if (hit) arr.splice(idx, 1)
      } else if (hit) {
        arr[idx] = { price, size }
      } else {
        arr.splice(idx, 0, { price, size })
      }
    }

    const replaceBook = (b: OrderBook) => {
      workingBids = b.bids
        .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
        .sort((a, b) => b.price - a.price) // desc
      workingAsks = b.asks
        .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
        .sort((a, b) => a.price - b.price) // asc
      workingVersion++
      schedule()
    }

    const es = new EventSource(`/api/stream/${tok}`)
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as StreamMsg
        if (msg.type === 'book') {
          // Polymarket's market channel can multicast book snapshots for both
          // tokens (YES + NO) of the same condition. We're only interested in
          // our own asset_id — otherwise the NO book would overwrite YES.
          if (msg.data.asset_id && msg.data.asset_id !== tok) return
          replaceBook(msg.data)
        } else if (msg.type === 'price_change') {
          let mutated = false
          for (const ch of msg.data.price_changes) {
            // Same story: only apply updates for our token. Otherwise the NO
            // side's bids land in our YES bid book and cross the spread.
            if (ch.asset_id && ch.asset_id !== tok) continue
            const price = Number(ch.price)
            const size = Number(ch.size)
            if (ch.side === 'BUY') {
              applyChange(workingBids, price, size, true)
            } else {
              applyChange(workingAsks, price, size, false)
            }
            mutated = true
          }
          if (mutated) {
            workingVersion++
            schedule()
          }
        } else if (msg.type === 'last_trade') {
          if (msg.data.asset_id && msg.data.asset_id !== tok) return
          lastTradeBuf = {
            price: Number(msg.data.price),
            size: Number(msg.data.size),
            side: msg.data.side,
            ts: Date.now(),
          }
          schedule()
        }
      } catch {}
    }

    onCleanup(() => {
      disposed = true
      es.close()
      if (rafId != null) cancelAnimationFrame(rafId)
    })
  })

  return { bids, asks, lastTrade, connected, version }
}
