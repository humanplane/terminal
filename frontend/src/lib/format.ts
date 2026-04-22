const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
})
const withCommas = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

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
