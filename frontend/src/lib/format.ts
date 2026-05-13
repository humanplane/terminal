import { createSignal } from 'solid-js'

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
})
const withCommas = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

// Shared minute-resolution clock for countdown chips. One module-level
// interval beats one timer per row in the virtualized list.
const [_now, _setNow] = createSignal(Date.now())
if (typeof window !== 'undefined') {
  setInterval(() => _setNow(Date.now()), 60_000)
}
export const now = _now

export const fmtUSD = (n?: number | null) => {
  if (n == null || !isFinite(n)) return '—'
  return `$${compact.format(n)}`
}

export const fmtUSDFull = (n?: number | null) => {
  if (n == null || !isFinite(n)) return '—'
  return `$${withCommas.format(n)}`
}

export const fmtPct = (n?: number | null, digits = 1) => {
  if (n == null || !isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

export const fmtProb = (n?: number | null) => {
  if (n == null || !isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}¢`
}

export const fmtNum = (n?: number | null, digits = 2) => {
  if (n == null || !isFinite(n)) return '—'
  return withCommas.format(Number(n.toFixed(digits)))
}

export const fmtDate = (iso?: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export const relativeTime = (iso?: string | null) => {
  if (!iso) return '—'
  const future = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(future)
  const sign = future >= 0 ? '' : '-'
  const day = 86_400_000
  if (abs > day * 365) return `${sign}${Math.round(abs / (day * 365))}y`
  if (abs > day * 30) return `${sign}${Math.round(abs / (day * 30))}mo`
  if (abs > day) return `${sign}${Math.round(abs / day)}d`
  if (abs > 3_600_000) return `${sign}${Math.round(abs / 3_600_000)}h`
  return `${sign}${Math.round(abs / 60_000)}m`
}

/** Compact countdown for resolution date. Returns 'settling' when past the
 *  end date but the market is still open. `nowMs` is taken from the shared
 *  `now()` signal so the chip ticks. */
export const fmtTimeLeft = (
  iso?: string | null,
  nowMs: number = Date.now()
): string | null => {
  if (!iso) return null
  const end = new Date(iso).getTime()
  if (isNaN(end)) return null
  const ms = end - nowMs
  if (ms <= 0) return 'settling'
  const day = 86_400_000
  if (ms > day * 365) return `${Math.round(ms / (day * 365))}y left`
  if (ms > day * 30) return `${Math.round(ms / (day * 30))}mo left`
  if (ms > day) return `${Math.round(ms / day)}d left`
  if (ms > 3_600_000) return `${Math.round(ms / 3_600_000)}h left`
  return `${Math.round(ms / 60_000)}m left`
}

/** Quick triage signal for the market list: how tradable is this market? */
export type LiquidityTier = 'thick' | 'mid' | 'thin'
export const liquidityTier = (m: {
  liquidityNum?: number
  spread?: number
  bestBid?: number
  bestAsk?: number
}): LiquidityTier => {
  const liq = m.liquidityNum ?? 0
  const spread =
    m.spread ?? (m.bestAsk != null && m.bestBid != null ? m.bestAsk - m.bestBid : 1)
  if (liq >= 5000 && spread <= 0.01) return 'thick'
  if (liq >= 500 && spread <= 0.05) return 'mid'
  return 'thin'
}
