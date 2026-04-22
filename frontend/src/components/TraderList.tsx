import { For, Show, createMemo, onCleanup, onMount, type JSX } from 'solid-js'
import type { TraderRanking } from '../lib/api'
import { favorites } from '../lib/favorites'
import { fmtUSD } from '../lib/format'
import { Avatar } from './Avatar'

type Props = {
  traders: TraderRanking[]
  loading: boolean
  period: 'day' | 'week' | 'month' | 'all'
  orderBy: 'pnl' | 'vol'
  onPeriodChange: (p: 'day' | 'week' | 'month' | 'all') => void
  onOrderByChange: (o: 'pnl' | 'vol') => void
  selectedWallet?: string
  onSelect: (t: TraderRanking) => void
  filter: string
  onFilterChange: (v: string) => void
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  ref?: (el: HTMLInputElement) => void
}

const PERIODS = [
  { k: 'day', l: '1D' },
  { k: 'week', l: '1W' },
  { k: 'month', l: '1M' },
  { k: 'all', l: 'ALL' },
] as const

export function TraderList(props: Props) {
  const filtered = createMemo(() => {
    const q = props.filter.trim().toLowerCase()
    const favs = favorites.traders()
    const list = !q
      ? props.traders
      : props.traders.filter(
          (t) =>
            (t.userName ?? '').toLowerCase().includes(q) ||
            t.proxyWallet.toLowerCase().includes(q)
        )
    // Favorites pinned on top, stable ordering otherwise.
    const starred: TraderRanking[] = []
    const rest: TraderRanking[] = []
    for (const t of list) {
      if (favs.has(t.proxyWallet.toLowerCase())) starred.push(t)
      else rest.push(t)
    }
    return [...starred, ...rest]
  })

  return (
    <div class="flex h-full flex-col">
      <div class="flex h-10 shrink-0 items-center border-b border-border-2 px-3">
        <div class="relative w-full">
          <input
            type="text"
            placeholder="search traders… (/)"
            ref={(el) => props.ref?.(el)}
            value={props.filter}
            onInput={(e) => props.onFilterChange(e.currentTarget.value)}
            class="h-7 w-full border border-border-2 bg-panel px-2 text-[11px] text-text-bright outline-none placeholder:text-text-dimmer focus:border-border-3"
          />
          <Show when={props.filter}>
            <button
              onClick={() => props.onFilterChange('')}
              aria-label="clear filter"
              class="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer text-[12px] leading-none text-text-dim hover:text-text-bright"
            >
              ×
            </button>
          </Show>
        </div>
      </div>

      {/* Leaderboard controls */}
      <div class="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border-2 px-3 eyebrow">
        <div class="segmented">
          <For each={PERIODS}>
            {(p) => (
              <button
                data-active={props.period === p.k}
                onClick={() => props.onPeriodChange(p.k)}
              >
                {p.l}
              </button>
            )}
          </For>
        </div>
        <div class="segmented">
          <button
            data-active={props.orderBy === 'pnl'}
            onClick={() => props.onOrderByChange('pnl')}
          >
            PnL
          </button>
          <button
            data-active={props.orderBy === 'vol'}
            onClick={() => props.onOrderByChange('vol')}
          >
            Vol
          </button>
        </div>
      </div>

      <div class="section-head section-head-dense">
        <span>rank · {filtered().length}</span>
        <span>{props.orderBy === 'pnl' ? 'PnL' : 'Volume'}</span>
      </div>

      <div class="relative flex-1 overflow-y-auto">
        <Show
          when={!props.loading}
          fallback={
            <div class="p-4 eyebrow">loading leaderboard…</div>
          }
        >
          <Show
            when={filtered().length}
            fallback={
              <div class="p-4 eyebrow">no traders match</div>
            }
          >
            <For each={filtered()}>
              {(t) => (
                <TraderRow
                  trader={t}
                  metric={props.orderBy}
                  selected={props.selectedWallet === t.proxyWallet}
                  onClick={() => props.onSelect(t)}
                />
              )}
            </For>
            <Show when={props.hasMore || props.loadingMore}>
              <InfiniteTrigger
                onVisible={() => props.onLoadMore()}
              >
                <div class="flex h-10 items-center justify-center border-t border-border eyebrow">
                  <Show when={props.loadingMore} fallback={<span>↓ load more</span>}>
                    <span>loading…</span>
                  </Show>
                </div>
              </InfiniteTrigger>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function InfiniteTrigger(props: {
  onVisible: () => void
  children: JSX.Element
}) {
  let el!: HTMLDivElement
  onMount(() => {
    // Disconnect+re-observe after each firing. Otherwise IO doesn't re-fire
    // when the sentinel stays in view during a fetch (fast connection or
    // short result set) — load-more stalls until the user scrolls.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            io.disconnect()
            props.onVisible()
            // Re-observe on the next microtask so the fresh layout after the
            // callback settles before we check intersection again.
            queueMicrotask(() => io.observe(el))
          }
        }
      },
      { threshold: 0.01 }
    )
    io.observe(el)
    onCleanup(() => io.disconnect())
  })
  return <div ref={el!}>{props.children}</div>
}

function TraderRow(props: {
  trader: TraderRanking
  metric: 'pnl' | 'vol'
  selected: boolean
  onClick: () => void
}) {
  const name = () => props.trader.userName || shortAddr(props.trader.proxyWallet)
  const value = () =>
    props.metric === 'pnl' ? props.trader.pnl : props.trader.vol
  const valueCls = () =>
    props.metric === 'pnl'
      ? value() >= 0
        ? 'text-up'
        : 'text-down'
      : 'text-text-bright'

  return (
    <button
      onClick={props.onClick}
      class={
        'relative flex h-12 w-full cursor-pointer items-center gap-3 border-b border-border px-3 text-left ' +
        (props.selected ? 'bg-panel-2' : 'hover:bg-panel')
      }
    >
      <Show when={props.selected}>
        <span class="absolute inset-y-0 left-0 w-0.5 bg-text-bright" />
      </Show>
      <span class="w-7 shrink-0 text-right text-[11px] tabular-nums text-text-dim">
        {props.trader.rank}
      </span>
      <Avatar
        src={props.trader.profileImage}
        seed={props.trader.userName ?? props.trader.proxyWallet}
        size="md"
        shape="circle"
        identicon
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <Show when={favorites.isTrader(props.trader.proxyWallet)}>
            <span class="text-[10px] text-text-bright">★</span>
          </Show>
          <div class="truncate text-[12px] font-semibold text-text-bright">
            {name()}
          </div>
        </div>
        <Show when={props.trader.userName && props.trader.userName !== shortAddr(props.trader.proxyWallet)}>
          <div class="truncate eyebrow">
            {shortAddr(props.trader.proxyWallet)}
          </div>
        </Show>
      </div>
      <div class={'shrink-0 tabular-nums text-[12px] font-semibold ' + valueCls()}>
        {fmtUSD(value())}
      </div>
    </button>
  )
}

function shortAddr(a: string) {
  if (!a) return ''
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
