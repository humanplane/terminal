import { createSignal } from 'solid-js'

const KEY = 'humanplane:favorites:v1'

type Store = {
  markets: Set<string> // market ids
  traders: Set<string> // proxyWallet addresses (lowercased)
}

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { markets: new Set(), traders: new Set() }
    const parsed = JSON.parse(raw) as {
      markets?: string[]
      traders?: string[]
    }
    return {
      markets: new Set(parsed.markets ?? []),
      traders: new Set((parsed.traders ?? []).map((a) => a.toLowerCase())),
    }
  } catch {
    return { markets: new Set(), traders: new Set() }
  }
}

function save(s: Store) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        markets: [...s.markets],
        traders: [...s.traders],
      })
    )
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn('favorites: localStorage write failed', err)
    }
  }
}

const [state, setState] = createSignal<Store>(load())

// Cross-tab sync: when another tab mutates the favorites key, reload.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) setState(load())
  })
}

function mutate(fn: (s: Store) => Store) {
  const next = fn(state())
  setState(next)
  save(next)
}

export const favorites = {
  markets: () => state().markets,
  traders: () => state().traders,

  isMarket: (id: string) => state().markets.has(id),
  isTrader: (addr: string) => state().traders.has(addr.toLowerCase()),

  toggleMarket: (id: string) =>
    mutate((s) => {
      const next = { ...s, markets: new Set(s.markets) }
      if (next.markets.has(id)) next.markets.delete(id)
      else next.markets.add(id)
      return next
    }),

  toggleTrader: (addr: string) =>
    mutate((s) => {
      const next = { ...s, traders: new Set(s.traders) }
      const k = addr.toLowerCase()
      if (next.traders.has(k)) next.traders.delete(k)
      else next.traders.add(k)
      return next
    }),
}
