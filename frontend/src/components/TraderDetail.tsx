import { For, Match, Show, Switch, createMemo, createSignal, type JSX } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { createQuery } from '@tanstack/solid-query'
import type {
  ClosedPosition,
  TraderRanking,
  UserActivity,
  UserPosition,
  UserTrade,
} from '../lib/api'
import { api } from '../lib/api'
import { favorites } from '../lib/favorites'
import { fmtUSD, fmtUSDFull, fmtPct, fmtNum } from '../lib/format'
import { Avatar } from './Avatar'

type Props = {
  trader: TraderRanking
}

type Tab = 'open' | 'closed' | 'trades' | 'activity'
const TABS: { k: Tab; l: string }[] = [
  { k: 'open', l: 'Open' },
  { k: 'closed', l: 'Closed' },
  { k: 'trades', l: 'Trades' },
  { k: 'activity', l: 'Activity' },
]

export function TraderDetail(props: Props) {
  const [tab, setTab] = createSignal<Tab>('open')
  const navigate = useNavigate()

  const addr = () => props.trader.proxyWallet
  const fav = () => favorites.isTrader(addr())
  const goMarket = (slug?: string) => {
    if (slug) navigate(`/market/${slug}`)
  }

  const openQ = createQuery(() => ({
    queryKey: ['positions', addr()],
    queryFn: ({ signal }) => api.userPositions(addr(), { limit: 100 }, signal),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  }))
  const closedQ = createQuery(() => ({
    queryKey: ['closed-positions', addr()],
    queryFn: ({ signal }) =>
      api.userClosedPositions(addr(), { limit: 100 }, signal),
    enabled: tab() === 'closed',
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  }))
  const tradesQ = createQuery(() => ({
    queryKey: ['trades', addr()],
    queryFn: ({ signal }) => api.userTrades(addr(), { limit: 100 }, signal),
    enabled: tab() === 'trades',
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  }))
  const activityQ = createQuery(() => ({
    queryKey: ['activity', addr()],
    queryFn: ({ signal }) => api.userActivity(addr(), { limit: 100 }, signal),
    enabled: tab() === 'activity',
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  }))

  const totals = createMemo(() => {
    const list = openQ.data ?? []
    let value = 0
    let pnl = 0
    for (const p of list) {
      value += p.currentValue ?? 0
      pnl += p.cashPnl ?? 0
    }
    return { value, pnl, count: list.length }
  })

  const name = () =>
    props.trader.userName || shortAddr(props.trader.proxyWallet)
  const seed = () =>
    props.trader.userName ?? props.trader.proxyWallet

  const currentCount = () => {
    switch (tab()) {
      case 'open':
        return openQ.data?.length ?? 0
      case 'closed':
        return closedQ.data?.length ?? 0
      case 'trades':
        return tradesQ.data?.length ?? 0
      case 'activity':
        return activityQ.data?.length ?? 0
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Breadcrumb */}
      <div class="section-head">
        <div class="flex min-w-0 items-center gap-3">
          <span class="eyebrow-bright">trader</span>
          <span class="text-border-3">·</span>
          <span>rank #{props.trader.rank}</span>
          <span class="text-border-3">·</span>
          <a
            href={`https://polymarket.com/profile/${addr()}`}
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono normal-case tracking-normal text-text-dim hover:text-text-bright"
          >
            {shortAddr(addr())} ↗
          </a>
        </div>
        <div class="flex shrink-0 items-center gap-3">
          <Show when={props.trader.xUsername}>
            <a
              href={`https://x.com/${props.trader.xUsername}`}
              target="_blank"
              rel="noopener noreferrer"
              class="hover:text-text-bright"
            >
              @{props.trader.xUsername}
            </a>
          </Show>
          <button
            onClick={() => favorites.toggleTrader(addr())}
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
          src={props.trader.profileImage}
          seed={seed()}
          size="xl"
          alt={name()}
          shape="circle"
          identicon
        />
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-[15px] font-semibold leading-tight text-text-bright">
            {name()}
          </h1>
          <div class="mt-1 flex flex-wrap items-center gap-2 eyebrow">
            <span>{shortAddr(addr())}</span>
            <Show when={props.trader.verifiedBadge}>
              <span class="text-up">· verified</span>
            </Show>
          </div>
        </div>
        <div class="shrink-0 text-right leading-none">
          <div
            class={
              'tabular-nums text-[24px] font-bold ' +
              (props.trader.pnl >= 0 ? 'text-up' : 'text-down')
            }
          >
            {props.trader.pnl >= 0 ? '+' : ''}
            {fmtUSD(props.trader.pnl)}
          </div>
          <div class="mt-1 eyebrow">all-time PnL</div>
        </div>
      </div>

      {/* Stats */}
      <div class="grid shrink-0 grid-cols-4 border-b border-border-2">
        <Stat label="Volume" value={fmtUSDFull(props.trader.vol)} />
        <Stat label="Open Positions" value={String(totals().count)} />
        <Stat label="Current Value" value={fmtUSDFull(totals().value)} />
        <Stat
          label="Unrealized"
          value={fmtUSDFull(totals().pnl)}
          tone={totals().pnl >= 0 ? 'up' : 'down'}
        />
      </div>

      {/* Tabs */}
      <div class="flex h-8 shrink-0 items-center justify-between border-b border-border-2 px-4 eyebrow">
        <div class="segmented">
          <For each={TABS}>
            {(t) => (
              <button
                data-active={tab() === t.k}
                onClick={() => setTab(t.k)}
              >
                {t.l}
              </button>
            )}
          </For>
        </div>
        <span class="tabular-nums">{currentCount()} rows</span>
      </div>

      {/* Tab body */}
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Switch>
          <Match when={tab() === 'open'}>
            <List
              loading={openQ.isLoading}
              items={openQ.data ?? []}
              empty="no open positions"
              renderItem={(p) => <OpenPositionRow p={p} onOpen={goMarket} />}
            />
          </Match>
          <Match when={tab() === 'closed'}>
            <List
              loading={closedQ.isLoading}
              items={closedQ.data ?? []}
              empty="no closed positions"
              renderItem={(p) => (
                <ClosedPositionRow p={p} onOpen={goMarket} />
              )}
            />
          </Match>
          <Match when={tab() === 'trades'}>
            <List
              loading={tradesQ.isLoading}
              items={tradesQ.data ?? []}
              empty="no trades"
              renderItem={(t) => <TradeRow t={t} onOpen={goMarket} />}
            />
          </Match>
          <Match when={tab() === 'activity'}>
            <List
              loading={activityQ.isLoading}
              items={activityQ.data ?? []}
              empty="no activity"
              renderItem={(a) => <ActivityRow a={a} onOpen={goMarket} />}
            />
          </Match>
        </Switch>
      </div>
    </div>
  )
}

/* ------ generic list wrapper ------ */

function List<T>(props: {
  loading: boolean
  items: T[]
  empty: string
  renderItem: (item: T) => JSX.Element
}) {
  return (
    <Show when={!props.loading} fallback={<SkeletonList />}>
      <Show
        when={props.items.length}
        fallback={
          <div class="flex h-full items-center justify-center eyebrow">
            {props.empty}
          </div>
        }
      >
        <For each={props.items}>{(i) => props.renderItem(i)}</For>
      </Show>
    </Show>
  )
}

/* ------ row components ------ */

function OpenPositionRow(props: { p: UserPosition; onOpen: (slug?: string) => void }) {
  const pnlCls = () => (props.p.cashPnl >= 0 ? 'text-up' : 'text-down')
  return (
    <Row
      icon={props.p.icon}
      title={props.p.title ?? '—'}
      seed={props.p.title ?? props.p.conditionId}
      onOpen={() => props.onOpen(props.p.slug)}
      chips={[
        { label: props.p.outcome, tone: outcomeTone(props.p.outcome) },
        { kv: ['size', fmtUSD(props.p.size)] },
        { kv: ['avg', `${(props.p.avgPrice * 100).toFixed(1)}¢`] },
        props.p.curPrice > 0
          ? { kv: ['now', `${(props.p.curPrice * 100).toFixed(1)}¢`], bright: true }
          : null,
      ]}
      right={
        <div class={'text-right tabular-nums ' + pnlCls()}>
          <div class="text-[13px] font-semibold leading-none">
            {props.p.cashPnl >= 0 ? '+' : ''}
            {fmtUSD(props.p.cashPnl)}
          </div>
          <div class="mt-1 text-[10px] leading-none">
            {props.p.cashPnl >= 0 ? '+' : ''}
            {fmtPct(props.p.percentPnl / 100, 1)}
          </div>
          <div class="mt-1.5 text-[10px] leading-none text-text-dim">
            {fmtUSDFull(props.p.currentValue)}
          </div>
        </div>
      }
    />
  )
}

function ClosedPositionRow(props: {
  p: ClosedPosition
  onOpen: (slug?: string) => void
}) {
  const pnlCls = () => (props.p.realizedPnl >= 0 ? 'text-up' : 'text-down')
  const bought = () => props.p.totalBought * props.p.avgPrice
  const pct = () => (bought() > 0 ? props.p.realizedPnl / bought() : 0)
  return (
    <Row
      icon={props.p.icon}
      title={props.p.title}
      seed={props.p.title}
      onOpen={() => props.onOpen(props.p.slug)}
      chips={[
        { label: props.p.outcome, tone: outcomeTone(props.p.outcome) },
        { kv: ['size', fmtUSD(props.p.totalBought)] },
        { kv: ['avg', `${(props.p.avgPrice * 100).toFixed(1)}¢`] },
        {
          kv: ['closed', fmtRelative(props.p.timestamp)],
        },
      ]}
      right={
        <div class={'text-right tabular-nums ' + pnlCls()}>
          <div class="text-[13px] font-semibold leading-none">
            {props.p.realizedPnl >= 0 ? '+' : ''}
            {fmtUSD(props.p.realizedPnl)}
          </div>
          <div class="mt-1 text-[10px] leading-none">
            {pct() >= 0 ? '+' : ''}
            {fmtPct(pct(), 1)}
          </div>
          <div class="mt-1.5 text-[10px] leading-none text-text-dim">
            realized
          </div>
        </div>
      }
    />
  )
}

function TradeRow(props: { t: UserTrade; onOpen: (slug?: string) => void }) {
  const sideCls = () => (props.t.side === 'BUY' ? 'text-up' : 'text-down')
  return (
    <Row
      icon={props.t.icon}
      title={props.t.title}
      seed={props.t.title}
      onOpen={() => props.onOpen(props.t.slug)}
      chips={[
        { label: props.t.side, tone: sideCls() },
        { label: props.t.outcome, tone: outcomeTone(props.t.outcome) },
        { kv: ['@', `${(props.t.price * 100).toFixed(1)}¢`] },
        { kv: ['size', fmtNum(props.t.size)] },
        { kv: ['when', fmtRelative(props.t.timestamp)] },
      ]}
      right={
        <div class="text-right tabular-nums">
          <div class="text-[13px] font-semibold leading-none text-text-bright">
            {fmtUSDFull(props.t.size * props.t.price)}
          </div>
          <div class="mt-1 text-[10px] leading-none text-text-dim">notional</div>
        </div>
      }
    />
  )
}

function ActivityRow(props: {
  a: UserActivity
  onOpen: (slug?: string) => void
}) {
  const a = () => props.a
  const typeCls = () => {
    const v = a()
    if (v.type === 'TRADE') return v.side === 'SELL' ? 'text-down' : 'text-up'
    if (v.type === 'REDEEM') return 'text-up'
    return 'text-text-bright'
  }
  return (
    <Row
      icon={a().icon}
      title={a().title ?? a().type}
      seed={a().title ?? a().conditionId}
      onOpen={() => props.onOpen(a().slug)}
      chips={[
        { label: a().type, tone: typeCls() },
        a().outcome
          ? { label: a().outcome!, tone: outcomeTone(a().outcome) }
          : null,
        a().price != null && a().price! > 0
          ? { kv: ['@', `${(a().price! * 100).toFixed(1)}¢`] }
          : null,
        { kv: ['size', fmtNum(a().size)] },
        { kv: ['when', fmtRelative(a().timestamp)] },
      ]}
      right={
        <div class="text-right tabular-nums">
          <div class="text-[13px] font-semibold leading-none text-text-bright">
            {fmtUSDFull(a().usdcSize)}
          </div>
          <Show when={a().transactionHash}>
            <a
              href={`https://polygonscan.com/tx/${a().transactionHash}`}
              target="_blank"
              rel="noopener noreferrer"
              class="mt-1 block text-[10px] leading-none text-text-dim hover:text-text-bright"
              title={a().transactionHash}
            >
              tx ↗
            </a>
          </Show>
        </div>
      }
    />
  )
}

/* ------ shared row template ------ */

type Chip =
  | { label: string; tone?: string }
  | { kv: [string, string]; bright?: boolean }
  | null

function Row(props: {
  icon?: string
  title: string
  seed: string
  chips: Chip[]
  right?: JSX.Element
  onOpen?: () => void
}) {
  return (
    <div
      class={
        'flex items-start gap-4 border-b border-border px-4 py-3 hover:bg-panel ' +
        (props.onOpen ? 'cursor-pointer' : '')
      }
      onClick={() => props.onOpen?.()}
      role={props.onOpen ? 'button' : undefined}
    >
      <Avatar src={props.icon} seed={props.seed} size="md" alt={props.title} />
      <div class="min-w-0 flex-1">
        <div class="line-clamp-2 text-[12px] leading-snug text-text-bright">
          {props.title}
        </div>
        <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-dim">
          <For each={props.chips.filter(Boolean) as Exclude<Chip, null>[]}>
            {(c, i) => (
              <>
                <Show when={i() > 0}>
                  <span class="text-border-3">·</span>
                </Show>
                <ChipView chip={c} />
              </>
            )}
          </For>
        </div>
      </div>
      <div class="shrink-0">{props.right}</div>
    </div>
  )
}

function ChipView(props: { chip: Exclude<Chip, null> }) {
  return (
    <Show
      when={'label' in props.chip}
      fallback={
        <span>
          <span class="text-text-dim">{(props.chip as any).kv[0]} </span>
          <span
            class={
              'tabular-nums ' +
              ((props.chip as any).bright ? 'text-text-bright' : 'text-text')
            }
          >
            {(props.chip as any).kv[1]}
          </span>
        </span>
      }
    >
      <span
        class={
          'font-semibold uppercase tracking-[0.14em] ' +
          ((props.chip as any).tone ?? 'text-text-dim')
        }
      >
        {(props.chip as any).label}
      </span>
    </Show>
  )
}

/* ------ skeleton ------ */

function SkeletonList() {
  return (
    <div>
      <For each={Array.from({ length: 8 })}>
        {() => (
          <div class="flex items-start gap-4 border-b border-border px-4 py-3">
            <div class="h-8 w-8 shrink-0 border border-border-2 bg-panel-2" />
            <div class="flex-1 space-y-1.5">
              <div class="h-3 w-5/6 bg-panel-2" />
              <div class="h-2 w-1/3 bg-panel" />
            </div>
            <div class="w-20 space-y-1.5">
              <div class="ml-auto h-3 w-16 bg-panel-2" />
              <div class="ml-auto h-2 w-12 bg-panel" />
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

/* ------ helpers ------ */

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

function shortAddr(a: string) {
  if (!a) return ''
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function outcomeTone(o: string | undefined | null) {
  const v = (o ?? '').toLowerCase()
  if (v === 'yes') return 'text-up'
  if (v === 'no') return 'text-down'
  return 'text-text-dim'
}

function fmtRelative(ts: number) {
  if (!ts) return '—'
  // Polymarket timestamps are UNIX seconds; positive = ago, negative = future.
  const agoMs = Date.now() - ts * 1000
  const abs = Math.abs(agoMs)
  const suffix = agoMs >= 0 ? ' ago' : ''
  const prefix = agoMs < 0 ? 'in ' : ''
  const day = 86_400_000
  const fmt = (n: number, unit: string) => `${prefix}${n}${unit}${suffix}`
  if (abs > day * 365) return fmt(Math.floor(abs / (day * 365)), 'y')
  if (abs > day * 30) return fmt(Math.floor(abs / (day * 30)), 'mo')
  if (abs > day) return fmt(Math.floor(abs / day), 'd')
  if (abs > 3_600_000) return fmt(Math.floor(abs / 3_600_000), 'h')
  return fmt(Math.max(1, Math.floor(abs / 60_000)), 'm')
}
