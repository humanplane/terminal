import { For, Show, createMemo, createSignal } from 'solid-js'
import { createQuery } from '@tanstack/solid-query'
import type { Event, Market, IntervalKey } from '../lib/api'
import { api, INTERVALS } from '../lib/api'
import { createLiveBook, type SortedLevel } from '../lib/stream'
import { favorites } from '../lib/favorites'
import { fmtPct, fmtUSDFull, fmtDate, relativeTime } from '../lib/format'
import { OrderBook } from './OrderBook'
import { PriceChart } from './PriceChart'
import { Avatar } from './Avatar'
import { TradesFeed } from './TradesFeed'
import { TopHolders } from './TopHolders'
import { TradePanel } from './TradePanel'

type Props = {
  market: Market
  event?: Event
}

type RightTab = 'book' | 'tape' | 'holders' | 'trade'
const RIGHT_TABS: { k: RightTab; l: string }[] = [
  { k: 'book', l: 'Book' },
  { k: 'tape', l: 'Tape' },
  { k: 'holders', l: 'Holders' },
  { k: 'trade', l: 'Trade' },
]

export function MarketDetail(props: Props) {
  const [descOpen, setDescOpen] = createSignal(false)
  const [interval, setInterval] = createSignal<IntervalKey>('1w')
  const [rightTab, setRightTab] = createSignal<RightTab>('book')

  const yesToken = () => props.market.clobTokenIds[0]

  const historyQuery = createQuery(() => ({
    queryKey: ['history', yesToken(), interval()],
    queryFn: ({ signal }) => api.getHistory(yesToken()!, interval(), signal),
    enabled: !!yesToken(),
    staleTime: 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  }))

  const live = createLiveBook(yesToken)

  const snapshotBookQuery = createQuery(() => ({
    queryKey: ['book', yesToken()],
    queryFn: ({ signal }) => api.getBook(yesToken()!, signal),
    enabled: !!yesToken(),
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  }))

  const snapSorted = createMemo<{
    bids: SortedLevel[]
    asks: SortedLevel[]
  } | null>(() => {
    const b = snapshotBookQuery.data
    if (!b) return null
    const bids = b.bids
      .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
      .sort((x, y) => y.price - x.price)
    const asks = b.asks
      .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
      .sort((x, y) => x.price - y.price)
    return { bids, asks }
  })

  const bidsView = (): SortedLevel[] =>
    live.version() > 0 ? live.bids() : (snapSorted()?.bids ?? [])
  const asksView = (): SortedLevel[] =>
    live.version() > 0 ? live.asks() : (snapSorted()?.asks ?? [])
  const haveBook = () =>
    live.version() > 0 || snapshotBookQuery.data != null

  // Live-preferred top-of-book — falls back to market metadata when book not
  // yet loaded. Keeps the stats strip ticking along with the order book.
  const bestBid = () => bidsView()[0]?.price ?? props.market.bestBid ?? null
  const bestAsk = () => asksView()[0]?.price ?? props.market.bestAsk ?? null
  const spreadCents = () => {
    const b = bestBid()
    const a = bestAsk()
    if (b == null || a == null) return null
    return (a - b) * 100
  }
  const liveYesPrice = () => {
    // Prefer the last-trade price from the live stream; else mid-of-book;
    // else stale outcomePrices metadata.
    const lt = live.lastTrade()?.price
    if (lt != null) return lt
    const b = bestBid()
    const a = bestAsk()
    if (b != null && a != null) return (a + b) / 2
    return props.market.outcomePrices[0] ?? null
  }

  // Live tick passed to the chart. Prefer `last_trade` prices (actual
  // executions); otherwise fall back to mid-of-book so the chart still moves
  // on quiet markets whose best bid/ask shift without trades.
  //
  // We throttle by bumping only when the value or second-resolution time has
  // changed, so lightweight-charts isn't hit on every book micro-update.
  let lastTickKey = ''
  const liveTick = () => {
    const lt = live.lastTrade()
    const b = bestBid()
    const a = bestAsk()
    let t: number
    let p: number | null = null
    if (lt) {
      t = Math.floor(lt.ts / 1000)
      p = lt.price
    } else if (b != null && a != null) {
      t = Math.floor(Date.now() / 1000)
      p = (a + b) / 2
    } else {
      return null
    }
    if (p == null) return null
    const key = `${t}:${p.toFixed(4)}`
    if (key === lastTickKey) return null
    lastTickKey = key
    return { t, p }
  }

  const image = () =>
    props.market.image ||
    props.market.icon ||
    props.event?.image ||
    props.event?.icon

  const yesLabel = () => props.market.outcomes[0] ?? 'YES'
  const fav = () => favorites.isMarket(props.market.id)

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Breadcrumb */}
      <div class="section-head">
        <div class="flex min-w-0 items-center gap-3 overflow-hidden">
          <Show when={props.event}>
            {(e) => (
              <span class="eyebrow-bright truncate">{e().title}</span>
            )}
          </Show>
          <Show when={props.market.endDate}>
            <span class="text-border-3">·</span>
            <span class="tabular-nums">
              {fmtDate(props.market.endDate)} ({relativeTime(props.market.endDate)})
            </span>
          </Show>
        </div>
        <div class="flex shrink-0 items-center gap-3">
          <Show when={live.connected()}>
            <span class="flex items-center gap-1.5 text-up">
              <span class="live-dot inline-block h-1.5 w-1.5 bg-up" />
              <span>LIVE</span>
            </span>
          </Show>
          <button
            onClick={() => favorites.toggleMarket(props.market.id)}
            class={
              'text-[13px] leading-none hover:text-text-bright ' +
              (fav() ? 'text-text-bright' : 'text-text-dim')
            }
            title={fav() ? 'un-favorite (f)' : 'favorite (f)'}
          >
            {fav() ? '★' : '☆'}
          </button>
        </div>
      </div>

      {/* Hero */}
      <div class="flex shrink-0 items-start gap-4 border-b border-border-2 px-4 py-4">
        <Avatar
          src={image()}
          seed={props.event?.ticker || props.market.question}
          size="lg"
        />
        <div class="min-w-0 flex-1">
          <h1 class="text-[13px] font-semibold leading-snug text-text-bright">
            {props.market.question}
          </h1>
          <div class="mt-1.5 eyebrow">{yesLabel()} probability</div>
        </div>
        <div class="shrink-0 text-right leading-none">
          <div
            class={
              'tabular-nums text-[26px] font-bold ' +
              (liveYesPrice() != null && liveYesPrice()! > 0.5
                ? 'text-up'
                : 'text-text-bright')
            }
          >
            {liveYesPrice() != null
              ? `${(liveYesPrice()! * 100).toFixed(0)}¢`
              : '—'}
          </div>
          <Show when={props.market.oneDayPriceChange != null}>
            <div
              class={
                'mt-2 tabular-nums text-[11px] font-semibold ' +
                (props.market.oneDayPriceChange! >= 0 ? 'text-up' : 'text-down')
              }
            >
              {props.market.oneDayPriceChange! >= 0 ? '+' : ''}
              {fmtPct(props.market.oneDayPriceChange, 1)} 24h
            </div>
          </Show>
        </div>
      </div>

      {/* Stat strip — best bid/ask and spread follow the live book. */}
      <div class="grid shrink-0 grid-cols-5 border-b border-border-2">
        <Stat label="24h Vol" value={fmtUSDFull(props.market.volume24hr)} />
        <Stat label="Liquidity" value={fmtUSDFull(props.market.liquidityNum)} />
        <Stat
          label="Best Bid"
          value={bestBid() != null ? `${(bestBid()! * 100).toFixed(1)}¢` : '—'}
          tone={bestBid() != null ? 'up' : undefined}
        />
        <Stat
          label="Best Ask"
          value={bestAsk() != null ? `${(bestAsk()! * 100).toFixed(1)}¢` : '—'}
          tone={bestAsk() != null ? 'down' : undefined}
        />
        <Stat
          label="Spread"
          value={spreadCents() != null ? `${spreadCents()!.toFixed(2)}¢` : '—'}
        />
      </div>

      {/* Chart + right panel */}
      <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div class="flex min-h-[340px] min-w-0 flex-1 flex-col border-b border-border-2 lg:border-b-0 lg:border-r">
          <div class="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-border px-4 eyebrow">
            <span class="shrink-0">price · {yesLabel()}</span>
            <div class="segmented">
              <For each={INTERVALS}>
                {(iv) => (
                  <button
                    onClick={() => setInterval(iv.key)}
                    data-active={interval() === iv.key}
                  >
                    {iv.label}
                  </button>
                )}
              </For>
            </div>
            <Show
              when={live.lastTrade()}
              fallback={<span class="w-28 shrink-0 text-right">—</span>}
            >
              {(t) => (
                <span
                  class={
                    'w-28 shrink-0 text-right normal-case ' +
                    (t().side === 'BUY' ? 'text-up' : 'text-down')
                  }
                  style={{ 'letter-spacing': 'normal' }}
                >
                  last <span class="tabular-nums">{(t().price * 100).toFixed(2)}¢</span>
                </span>
              )}
            </Show>
          </div>
          <div class="relative min-h-0 flex-1">
            <Show
              when={
                historyQuery.data?.history?.length
                  ? historyQuery.data.history
                  : undefined
              }
              keyed
              fallback={
                <div class="flex h-full items-center justify-center eyebrow">
                  {historyQuery.isLoading ? 'loading…' : 'no history'}
                </div>
              }
            >
              {(history) => <PriceChart data={history} liveTick={liveTick()} />}
            </Show>
          </div>
        </div>

        {/* Right panel: tabbed Book / Tape / Holders */}
        <div class="flex min-h-0 flex-col lg:w-[360px] lg:shrink-0">
          <div class="flex h-8 shrink-0 items-center justify-between border-b border-border px-3 eyebrow">
            <div class="segmented">
              <For each={RIGHT_TABS}>
                {(t) => (
                  <button
                    data-active={rightTab() === t.k}
                    onClick={() => setRightTab(t.k)}
                  >
                    {t.l}
                  </button>
                )}
              </For>
            </div>
            <Show when={rightTab() === 'book' && haveBook()}>
              <span class="tabular-nums">
                {bidsView().length}b / {asksView().length}a
              </span>
            </Show>
          </div>
          <div class="min-h-0 flex-1 overflow-hidden">
            <Show when={rightTab() === 'book'}>
              <OrderBook bids={bidsView()} asks={asksView()} levels={14} />
            </Show>
            <Show when={rightTab() === 'tape'}>
              <TradesFeed conditionId={props.market.conditionId} />
            </Show>
            <Show when={rightTab() === 'holders'}>
              <TopHolders market={props.market} />
            </Show>
            <Show when={rightTab() === 'trade'}>
              <TradePanel market={props.market} />
            </Show>
          </div>
        </div>
      </div>

      {/* Resolution criteria */}
      <Show when={props.market.description}>
        <div class="shrink-0 border-t border-border-2">
          <button
            onClick={() => setDescOpen((v) => !v)}
            class="flex h-8 w-full cursor-pointer items-center justify-between border-b border-border px-4 eyebrow hover:text-text-bright"
          >
            <span>resolution criteria</span>
            <span class="text-[14px] leading-none">{descOpen() ? '−' : '+'}</span>
          </button>
          <Show when={descOpen()}>
            <div class="min-h-[80px] max-h-[25vh] overflow-y-auto px-4 py-3 text-[11px] leading-relaxed text-text">
              <p class="whitespace-pre-wrap">{props.market.description}</p>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function Stat(props: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div class="border-r border-border last:border-r-0 px-4 py-2.5">
      <div class="eyebrow">{props.label}</div>
      <div
        class={
          'mt-1 truncate tabular-nums text-[12px] font-semibold text-text-bright ' +
          (props.tone === 'up'
            ? '!text-up'
            : props.tone === 'down'
              ? '!text-down'
              : '')
        }
      >
        {props.value}
      </div>
    </div>
  )
}
