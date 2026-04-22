import { For, Index, Show, createMemo } from 'solid-js'
import type { SortedLevel } from '../lib/stream'
import { fmtNum } from '../lib/format'

type Props = {
  // Sorted: bids descending (best/highest first), asks ascending (best/lowest first).
  bids: SortedLevel[]
  asks: SortedLevel[]
  levels?: number
}

type DisplayLevel = { price: number; size: number; cum: number }

export function OrderBook(props: Props) {
  const levels = () => props.levels ?? 14

  // Cumulative starts at the best price and grows outward. For display we
  // reverse the ask list so the best ask sits directly above the spread bar.
  const asks = createMemo<DisplayLevel[]>(() => {
    const src = props.asks
    const n = Math.min(src.length, levels())
    const out: DisplayLevel[] = new Array(n)
    let cum = 0
    for (let i = 0; i < n; i++) {
      cum += src[i].size
      out[i] = { price: src[i].price, size: src[i].size, cum }
    }
    // Reverse in place for display order: farthest ask at top, best at bottom.
    out.reverse()
    return out
  })

  const bids = createMemo<DisplayLevel[]>(() => {
    const src = props.bids
    const n = Math.min(src.length, levels())
    const out: DisplayLevel[] = new Array(n)
    let cum = 0
    for (let i = 0; i < n; i++) {
      cum += src[i].size
      out[i] = { price: src[i].price, size: src[i].size, cum }
    }
    return out
  })

  const maxCum = createMemo(() => {
    const a = asks()
    const b = bids()
    let m = 1
    // asks cum grows away from spread → top row has max
    if (a.length) m = Math.max(m, a[0].cum)
    if (b.length) m = Math.max(m, b[b.length - 1].cum)
    return m
  })

  const spread = createMemo(() => {
    const a = asks()
    const b = bids()
    if (!a.length || !b.length) return null
    const bestAsk = a[a.length - 1].price
    const bestBid = b[0].price
    return {
      bestAsk,
      bestBid,
      spread: bestAsk - bestBid,
      mid: (bestAsk + bestBid) / 2,
    }
  })

  const hasBook = () => props.bids.length > 0 || props.asks.length > 0

  return (
    <div class="flex h-full flex-col text-[11px]">
      <div class="grid shrink-0 grid-cols-3 gap-2 border-b border-border px-3 py-1.5 text-[9px] uppercase tracking-[0.15em] text-text-dim">
        <span>Price</span>
        <span class="text-right">Size</span>
        <span class="text-right">Cum</span>
      </div>

      <Show
        when={hasBook()}
        fallback={
          <div class="flex flex-1 flex-col">
            <div class="flex flex-1 flex-col justify-end">
              <For each={Array.from({ length: 7 })}>
                {(_item, i) => (
                  <div class="flex items-center gap-2 px-3 py-[3px] leading-[18px]">
                    <div class="skeleton h-2.5 w-12" />
                    <div
                      class="skeleton ml-auto h-2.5"
                      style={{ width: `${20 + (i() % 3) * 15}%` }}
                    />
                  </div>
                )}
              </For>
            </div>
            <div class="border-y border-border-3 bg-panel-2 px-3 py-1.5">
              <div class="flex items-center justify-between">
                <div class="skeleton h-2.5 w-20" />
                <div class="skeleton h-2.5 w-16" />
              </div>
            </div>
            <div class="flex flex-1 flex-col">
              <For each={Array.from({ length: 7 })}>
                {(_item, i) => (
                  <div class="flex items-center gap-2 px-3 py-[3px] leading-[18px]">
                    <div class="skeleton h-2.5 w-12" />
                    <div
                      class="skeleton ml-auto h-2.5"
                      style={{ width: `${20 + (i() % 3) * 15}%` }}
                    />
                  </div>
                )}
              </For>
            </div>
          </div>
        }
      >
        <div class="flex flex-1 flex-col justify-end overflow-hidden">
          <Index each={asks()}>
            {(lvl) => <Row lvl={lvl()} maxCum={maxCum()} side="ask" />}
          </Index>
        </div>

        <div class="shrink-0 border-y border-border-3 bg-panel-2 px-3 py-1.5">
          <Show
            when={spread()}
            fallback={<span class="text-text-dim">—</span>}
          >
            {(s) => (
              <div class="flex items-center justify-between text-[11px]">
                <span class="font-semibold text-text-bright">
                  mid {(s().mid * 100).toFixed(2)}¢
                </span>
                <span class="text-text-dim">
                  spread {(s().spread * 100).toFixed(2)}¢
                </span>
              </div>
            )}
          </Show>
        </div>

        <div class="flex flex-1 flex-col overflow-hidden">
          <Index each={bids()}>
            {(lvl) => <Row lvl={lvl()} maxCum={maxCum()} side="bid" />}
          </Index>
        </div>
      </Show>
    </div>
  )
}

function Row(props: { lvl: DisplayLevel; maxCum: number; side: 'bid' | 'ask' }) {
  const pct = () => (props.lvl.cum / props.maxCum) * 100
  const bar = () =>
    props.side === 'bid' ? 'rgba(0, 201, 114, 0.22)' : 'rgba(255, 51, 85, 0.20)'
  const priceCls = () =>
    props.side === 'bid' ? 'text-up' : 'text-down'

  return (
    <div class="relative grid grid-cols-3 gap-2 px-3 py-[3px] leading-[18px]">
      <div
        class="absolute inset-y-0 right-0"
        style={{
          width: `${pct()}%`,
          background: bar(),
        }}
      />
      <span class={`relative ${priceCls()}`}>
        {(props.lvl.price * 100).toFixed(2)}¢
      </span>
      <span class="relative text-right text-text">{fmtNum(props.lvl.size)}</span>
      <span class="relative text-right text-text-dim">
        {fmtNum(props.lvl.cum)}
      </span>
    </div>
  )
}
