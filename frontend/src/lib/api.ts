// Parsed Market — all JSON-encoded fields (outcomes, outcomePrices, clobTokenIds)
// have been decoded once at the query boundary so the UI never calls JSON.parse
// in a hot path.
export type Market = {
  id: string
  question: string
  slug: string
  conditionId: string
  ticker?: string
  endDate?: string
  startDate?: string
  description?: string
  outcomes: string[]
  outcomePrices: number[]
  clobTokenIds: string[]
  volume?: string
  volumeNum?: number
  volume24hr?: number
  liquidity?: string
  liquidityNum?: number
  active?: boolean
  closed?: boolean
  enableOrderBook?: boolean
  bestBid?: number
  bestAsk?: number
  spread?: number
  lastTradePrice?: number
  oneDayPriceChange?: number
  oneWeekPriceChange?: number
  image?: string
  icon?: string
  acceptingOrders?: boolean
  negRisk?: boolean
  groupItemTitle?: string
  orderPriceMinTickSize?: number
  orderMinSize?: number
  tags?: { id: string; label: string; slug: string }[]
}

export type Event = {
  id: string
  ticker: string
  slug: string
  title: string
  description?: string
  image?: string
  icon?: string
  startDate?: string
  endDate?: string
  active?: boolean
  closed?: boolean
  liquidity?: number
  volume?: number
  volume24hr?: number
  openInterest?: number
  commentCount?: number
  markets: Market[]
  tags?: { id: string; label: string; slug: string }[]
}

export type OrderBookSide = { price: string; size: string }
export type OrderBook = {
  market: string
  asset_id: string
  timestamp: string
  hash: string
  bids: OrderBookSide[]
  asks: OrderBookSide[]
}

export type HistoryPoint = { t: number; p: number }
export type History = { history: HistoryPoint[] }

export type TraderRanking = {
  rank: string
  proxyWallet: string
  userName?: string | null
  vol: number
  pnl: number
  profileImage?: string | null
  xUsername?: string | null
  verifiedBadge?: boolean | null
}

export type UserPosition = {
  asset: string
  conditionId: string
  eventSlug?: string
  icon?: string
  title?: string
  slug?: string
  outcome: string
  outcomeIndex: number
  size: number
  avgPrice: number
  curPrice: number
  initialValue: number
  currentValue: number
  cashPnl: number
  percentPnl: number
  realizedPnl: number
  percentRealizedPnl: number
  endDate?: string
  negativeRisk?: boolean
  proxyWallet: string
}

export type ClosedPosition = {
  proxyWallet: string
  asset: string
  conditionId: string
  avgPrice: number
  totalBought: number
  realizedPnl: number
  curPrice: number
  timestamp: number
  title: string
  slug: string
  icon?: string
  eventSlug?: string
  outcome: string
  outcomeIndex: number
  endDate?: string
}

export type UserTrade = {
  proxyWallet: string
  side: 'BUY' | 'SELL'
  asset: string
  conditionId: string
  size: number
  price: number
  timestamp: number
  title: string
  slug: string
  icon?: string
  eventSlug?: string
  outcome: string
  outcomeIndex: number
}

export type ActivityType =
  | 'TRADE'
  | 'REDEEM'
  | 'MERGE'
  | 'SPLIT'
  | 'CONVERT'
  | 'REWARD'
  | string

export type UserActivity = {
  proxyWallet: string
  timestamp: number
  conditionId: string
  type: ActivityType
  size: number
  usdcSize: number
  price?: number
  asset?: string
  side?: 'BUY' | 'SELL' | ''
  outcomeIndex?: number
  title?: string
  slug?: string
  icon?: string
  outcome?: string
  transactionHash?: string
}

const base = '/api'

async function json<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${base}${path}`, { signal })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`)
  return r.json() as Promise<T>
}

function parseArr<T>(v: unknown, fb: T): T {
  if (Array.isArray(v)) return v as unknown as T
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v)
      return Array.isArray(p) ? (p as unknown as T) : fb
    } catch {
      return fb
    }
  }
  return fb
}

const num = (v: unknown): number | undefined => {
  if (v == null) return undefined
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : undefined
const bool = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : typeof v === 'string' ? v === 'true' : undefined

function normalizeMarket(m: Record<string, unknown>): Market {
  return {
    id: String(m.id ?? ''),
    question: String(m.question ?? ''),
    slug: String(m.slug ?? ''),
    conditionId: String(m.conditionId ?? ''),
    ticker: str(m.ticker),
    endDate: str(m.endDate),
    startDate: str(m.startDate),
    description: str(m.description),
    outcomes: parseArr<string[]>(m.outcomes, []),
    outcomePrices: parseArr<string[]>(m.outcomePrices, []).map((p) =>
      Number(p)
    ),
    clobTokenIds: parseArr<string[]>(m.clobTokenIds, []),
    volume: str(m.volume),
    volumeNum: num(m.volumeNum),
    volume24hr: num(m.volume24hr),
    liquidity: str(m.liquidity),
    liquidityNum: num(m.liquidityNum),
    active: bool(m.active),
    closed: bool(m.closed),
    enableOrderBook: bool(m.enableOrderBook),
    bestBid: num(m.bestBid),
    bestAsk: num(m.bestAsk),
    spread: num(m.spread),
    lastTradePrice: num(m.lastTradePrice),
    oneDayPriceChange: num(m.oneDayPriceChange),
    oneWeekPriceChange: num(m.oneWeekPriceChange),
    image: str(m.image),
    icon: str(m.icon),
    acceptingOrders: bool(m.acceptingOrders),
    negRisk: bool(m.negRisk),
    groupItemTitle: str(m.groupItemTitle),
    orderPriceMinTickSize: num(m.orderPriceMinTickSize),
    orderMinSize: num(m.orderMinSize),
    tags: Array.isArray(m.tags)
      ? (m.tags as { id: string; label: string; slug: string }[])
      : undefined,
  }
}

function normalizeEvent(e: Record<string, unknown>): Event {
  const markets = Array.isArray(e.markets)
    ? (e.markets as Record<string, unknown>[]).map(normalizeMarket)
    : []
  return { ...(e as unknown as Event), markets }
}

function normalizeHolder(h: Record<string, unknown>): Holder {
  // Accept either snake_case (polyoxide raw) or camelCase.
  const pick = (snake: string, camel: string) =>
    h[camel] ?? h[snake]
  return {
    proxyWallet: String(pick('proxy_wallet', 'proxyWallet') ?? ''),
    asset: String(pick('asset', 'asset') ?? ''),
    outcomeIndex: Number(pick('outcome_index', 'outcomeIndex') ?? 0),
    amount: Number(h.amount ?? 0),
    pseudonym: (pick('pseudonym', 'pseudonym') as string) || undefined,
    name: (pick('name', 'name') as string) || undefined,
    profileImage:
      (pick('profile_image_optimized', 'profileImageOptimized') as string) ||
      (pick('profile_image', 'profileImage') as string) ||
      undefined,
    displayUsernamePublic:
      (pick('display_username_public', 'displayUsernamePublic') as boolean) ??
      undefined,
  }
}

export const api = {
  listMarkets: async (
    params: { limit?: number; offset?: number; order?: string; volumeMin?: number } = {},
    signal?: AbortSignal
  ): Promise<Market[]> => {
    const q = new URLSearchParams()
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    if (params.order) q.set('order', params.order)
    if (params.volumeMin != null) q.set('volume_min', String(params.volumeMin))
    const qs = q.toString()
    const raw = await json<Record<string, unknown>[]>(
      `/markets${qs ? `?${qs}` : ''}`,
      signal
    )
    return raw.map(normalizeMarket)
  },

  getBook: (tokenId: string, signal?: AbortSignal) =>
    json<OrderBook>(`/book/${tokenId}`, signal),

  getHistory: (
    tokenId: string,
    interval?: string,
    signal?: AbortSignal
  ) =>
    json<History>(
      `/history/${tokenId}${interval ? `?interval=${interval}` : ''}`,
      signal
    ),

  listEvents: async (
    params: { limit?: number; offset?: number; active?: boolean } = {},
    signal?: AbortSignal
  ): Promise<Event[]> => {
    const q = new URLSearchParams()
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    if (params.active != null) q.set('active', String(params.active))
    const qs = q.toString()
    const raw = await json<Record<string, unknown>[]>(
      `/events${qs ? `?${qs}` : ''}`,
      signal
    )
    return raw.map(normalizeEvent)
  },

  eventsPage: async (
    offset: number,
    limit: number,
    signal?: AbortSignal
  ): Promise<Event[]> => {
    const raw = await json<Record<string, unknown>[]>(
      `/events?limit=${limit}&offset=${offset}&active=true`,
      signal
    )
    return raw.map(normalizeEvent)
  },

  searchEvents: async (
    q: string,
    page = 1,
    limitPerType = 40,
    signal?: AbortSignal
  ): Promise<{ events: Event[] }> => {
    const raw = await json<{
      events?: Record<string, unknown>[]
      profiles?: unknown[]
      tags?: unknown[]
    }>(
      `/search?q=${encodeURIComponent(q)}&page=${page}&limit_per_type=${limitPerType}`,
      signal
    )
    return { events: (raw.events ?? []).map(normalizeEvent) }
  },

  leaderboard: async (
    params: {
      period?: 'day' | 'week' | 'month' | 'all'
      orderBy?: 'pnl' | 'vol'
      category?: string
      limit?: number
      offset?: number
    } = {},
    signal?: AbortSignal
  ): Promise<TraderRanking[]> => {
    const q = new URLSearchParams()
    if (params.period) q.set('period', params.period)
    if (params.orderBy) q.set('order_by', params.orderBy)
    if (params.category) q.set('category', params.category)
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    const qs = q.toString()
    const raw = await json<Record<string, unknown>[]>(
      `/leaderboard${qs ? `?${qs}` : ''}`,
      signal
    )
    // Coerce fields — some responses use int ranks, nullable images, etc.
    return raw.map((r) => ({
      rank: String(r.rank ?? '—'),
      proxyWallet: String(r.proxyWallet ?? r['proxy_wallet'] ?? ''),
      userName: (r.userName as string | null | undefined) ?? null,
      vol: Number(r.vol ?? 0),
      pnl: Number(r.pnl ?? 0),
      profileImage: (r.profileImage as string | null | undefined) ?? null,
      xUsername: (r.xUsername as string | null | undefined) ?? null,
      verifiedBadge: (r.verifiedBadge as boolean | null | undefined) ?? null,
    }))
  },

  userPositions: (
    addr: string,
    params: { limit?: number; offset?: number } = {},
    signal?: AbortSignal
  ): Promise<UserPosition[]> => {
    const q = new URLSearchParams()
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    const qs = q.toString()
    return json<UserPosition[]>(
      `/user/${addr}/positions${qs ? `?${qs}` : ''}`,
      signal
    )
  },

  userClosedPositions: (
    addr: string,
    params: { limit?: number; offset?: number } = {},
    signal?: AbortSignal
  ): Promise<ClosedPosition[]> => {
    const q = new URLSearchParams()
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    const qs = q.toString()
    return json<ClosedPosition[]>(
      `/user/${addr}/closed-positions${qs ? `?${qs}` : ''}`,
      signal
    )
  },

  userTrades: (
    addr: string,
    params: { limit?: number; offset?: number } = {},
    signal?: AbortSignal
  ): Promise<UserTrade[]> => {
    const q = new URLSearchParams()
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    const qs = q.toString()
    return json<UserTrade[]>(
      `/user/${addr}/trades${qs ? `?${qs}` : ''}`,
      signal
    )
  },

  userActivity: (
    addr: string,
    params: { limit?: number; offset?: number } = {},
    signal?: AbortSignal
  ): Promise<UserActivity[]> => {
    const q = new URLSearchParams()
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    const qs = q.toString()
    return json<UserActivity[]>(
      `/user/${addr}/activity${qs ? `?${qs}` : ''}`,
      signal
    )
  },

  marketTrades: (
    conditionId: string,
    params: { limit?: number; offset?: number } = {},
    signal?: AbortSignal
  ): Promise<UserTrade[]> => {
    const q = new URLSearchParams()
    q.set('market', conditionId)
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    return json<UserTrade[]>(`/trades?${q.toString()}`, signal)
  },

  topHolders: async (
    conditionId: string,
    params: { limit?: number; minBalance?: number } = {},
    signal?: AbortSignal
  ): Promise<MarketHolders[]> => {
    const q = new URLSearchParams()
    q.set('market', conditionId)
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.minBalance != null) q.set('min_balance', String(params.minBalance))
    const raw = await json<
      Array<{ token: string; holders: Record<string, unknown>[] }>
    >(`/holders?${q.toString()}`, signal)
    // Backend returns holder fields in snake_case (polyoxide's Holder struct
    // doesn't apply camelCase on serialize). Normalize here.
    return raw.map((g) => ({
      token: g.token,
      holders: g.holders.map(normalizeHolder),
    }))
  },

  getMarketBySlug: async (slug: string, signal?: AbortSignal): Promise<Market | null> => {
    // Gamma lets us get a market directly by slug via /markets?slug=...
    const raw = await json<Record<string, unknown>[]>(
      `/markets?slug=${encodeURIComponent(slug)}`,
      signal
    )
    if (!raw.length) return null
    return normalizeMarket(raw[0])
  },
}

export type Holder = {
  proxyWallet: string
  asset: string
  outcomeIndex: number
  amount: number
  pseudonym?: string
  name?: string
  profileImage?: string
  displayUsernamePublic?: boolean
}
export type MarketHolders = {
  token: string
  holders: Holder[]
}

export const INTERVALS = [
  { key: '1h', label: '1H' },
  { key: '6h', label: '6H' },
  { key: '1d', label: '1D' },
  { key: '1w', label: '1W' },
  { key: '1m', label: '1M' },
  { key: 'max', label: 'MAX' },
] as const
export type IntervalKey = (typeof INTERVALS)[number]['key']
