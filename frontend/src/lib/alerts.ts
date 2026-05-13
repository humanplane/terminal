/**
 * Price-alert manager: localStorage-persisted rules, polled on a fixed
 * interval. Alerts fire **only while the terminal tab is open** — there is
 * no Service Worker, no background push. Documented in the README.
 *
 * Each tick fetches `/api/book/:tokenId` for every active alert and uses the
 * mid-of-book as the current price. To avoid notification spam on choppy
 * markets, alerts only fire on *crossings* (last seen price was on the other
 * side of the threshold). Non-rearming alerts deactivate themselves after
 * the first cross; the user can re-arm manually.
 */

import { createSignal } from 'solid-js'
import { api } from './api'
import { showToast } from './toast'

const LS_KEY = 'humanplane:alerts:v1'
const POLL_MS = 30_000
const MAX_ACTIVE = 20

export type AlertDirection = 'above' | 'below'

export type PriceAlert = {
  id: string
  conditionId: string
  marketSlug: string
  marketTitle: string
  tokenId: string
  outcomeLabel: string
  direction: AlertDirection
  /** Threshold in cents (0-100). Matches the price chips throughout the UI. */
  thresholdCents: number
  active: boolean
  /** Re-arm automatically after firing. Otherwise deactivates after one cross. */
  rearm: boolean
  createdAt: number
  lastFiredAt?: number
  /** Last observed mid price (cents) — used to detect crossings, not displays. */
  lastPriceCents?: number
}

const [_alerts, _setAlerts] = createSignal<PriceAlert[]>([])
export const alerts = _alerts

let pollHandle: number | null = null

function load(): PriceAlert[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persist(next: PriceAlert[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next))
  } catch {
    /* quota — drop oldest? for now just no-op */
  }
}

function mutate(fn: (cur: PriceAlert[]) => PriceAlert[]) {
  const next = fn(_alerts())
  persist(next)
  _setAlerts(next)
}

/** Called once from App's onMount. Hydrates state and starts polling. */
export function initAlerts() {
  if (pollHandle != null) return
  _setAlerts(load())
  void tick()
  pollHandle = window.setInterval(() => void tick(), POLL_MS) as unknown as number
}

async function tick() {
  const active = _alerts().filter((a) => a.active).slice(0, MAX_ACTIVE)
  if (!active.length) return
  await Promise.allSettled(
    active.map(async (a) => {
      try {
        const book = await api.getBook(a.tokenId)
        const bestBid = book.bids?.length ? Number(book.bids[0].price) : null
        const bestAsk = book.asks?.length ? Number(book.asks[0].price) : null
        let priceCents: number | null = null
        if (bestBid != null && bestAsk != null) {
          priceCents = ((bestBid + bestAsk) / 2) * 100
        } else if (bestBid != null) {
          priceCents = bestBid * 100
        } else if (bestAsk != null) {
          priceCents = bestAsk * 100
        }
        if (priceCents == null || !Number.isFinite(priceCents)) return

        const prev = a.lastPriceCents
        const crossed =
          a.direction === 'above'
            ? priceCents >= a.thresholdCents &&
              (prev == null || prev < a.thresholdCents)
            : priceCents <= a.thresholdCents &&
              (prev == null || prev > a.thresholdCents)

        if (crossed) {
          fire(a, priceCents)
          mutate((cur) =>
            cur.map((x) =>
              x.id === a.id
                ? {
                    ...x,
                    lastPriceCents: priceCents!,
                    lastFiredAt: Date.now(),
                    active: x.rearm,
                  }
                : x
            )
          )
        } else {
          // Just update the last seen price; no other state change.
          mutate((cur) =>
            cur.map((x) =>
              x.id === a.id ? { ...x, lastPriceCents: priceCents! } : x
            )
          )
        }
      } catch {
        /* swallow per-alert errors; next tick retries */
      }
    })
  )
}

function fire(a: PriceAlert, priceCents: number) {
  const body = `${a.outcomeLabel} ${priceCents.toFixed(1)}¢ · crossed ${a.direction} ${a.thresholdCents}¢`
  try {
    if (
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      new Notification(a.marketTitle, { body })
    }
  } catch {
    /* notifications API absent or blocked */
  }
  showToast({
    kind: 'alert',
    message: `${a.marketTitle} — ${body}`,
    marketSlug: a.marketSlug,
  })
}

export function addAlert(
  input: Omit<PriceAlert, 'id' | 'createdAt' | 'active' | 'lastPriceCents'>
): PriceAlert {
  const id = Math.random().toString(36).slice(2, 10)
  const alert: PriceAlert = {
    ...input,
    id,
    createdAt: Date.now(),
    active: true,
  }
  mutate((cur) => [...cur, alert])
  // Lazily request permission on first add so the user always knows why
  // they're being prompted.
  if (
    typeof Notification !== 'undefined' &&
    Notification.permission === 'default'
  ) {
    Notification.requestPermission().catch(() => {})
  }
  return alert
}

export function removeAlert(id: string) {
  mutate((cur) => cur.filter((a) => a.id !== id))
}

export function toggleAlert(id: string) {
  mutate((cur) =>
    cur.map((a) => (a.id === id ? { ...a, active: !a.active } : a))
  )
}

export function alertsForMarket(conditionId: string): PriceAlert[] {
  return _alerts().filter((a) => a.conditionId === conditionId)
}
