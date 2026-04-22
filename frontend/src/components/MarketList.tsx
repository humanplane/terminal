import { For, Index, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import type { Event, Market } from '../lib/api'
import { favorites } from '../lib/favorites'
import { fmtUSD } from '../lib/format'
import { Avatar } from './Avatar'

type Props = {
  events: Event[]
  selectedMarketId?: string
  onSelect: (m: Market) => void
  filter: string
  onFilterChange: (v: string) => void
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  searching: boolean
  ref?: (el: HTMLInputElement) => void
}

type Row = {
  event: Event
  markets: Market[]
  expanded: boolean
}

// 8-px grid: event row 56, market row 40. Inner scroll caps at 5 rows = 200.
const EVENT_H = 56
const MARKET_H = 40
const INNER_ROWS = 5

export function MarketList(props: Props) {
  let scrollRef!: HTMLDivElement

  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())

  const toggleEvent = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const rows = createMemo<Row[]>(() => {
    const q = props.filter.trim().toLowerCase()
    const searching = q.length > 0
    const exp = expanded()
    const favMarkets = favorites.markets()

    const out: Row[] = []
    // Two passes: favorites first (events that contain any starred market),
    // then the rest.
    const passes: Event[][] = [
      props.events.filter((e) =>
        e.markets.some((m) => favMarkets.has(m.id))
      ),
      props.events.filter(
        (e) => !e.markets.some((m) => favMarkets.has(m.id))
      ),
    ]

    for (const pass of passes) {
      for (const ev of pass) {
        const evTitleMatch =
          !searching ||
          ev.title.toLowerCase().includes(q) ||
          (ev.ticker ?? '').toLowerCase().includes(q)

        const matchingMarkets = ev.markets.filter((m) => {
          if (!searching) return true
          return evTitleMatch || m.question.toLowerCase().includes(q)
        })
        if (matchingMarkets.length === 0) continue

        out.push({
          event: ev,
          markets: matchingMarkets,
          expanded: searching || exp.has(ev.id),
        })
      }
    }
    return out
  })

  const virtualizer = createVirtualizer({
    get count() {
      return rows().length
    },
    getScrollElement: () => scrollRef,
    estimateSize: (i) => {
      const r = rows()[i]
      if (!r) return EVENT_H
      if (!r.expanded) return EVENT_H
      return EVENT_H + Math.min(r.markets.length, INNER_ROWS) * MARKET_H
    },
    overscan: 4,
  })

  const totalMarkets = createMemo(() =>
    props.events.reduce((n, e) => n + e.markets.length, 0)
  )

  createEffect(() => {
    const items = virtualizer.getVirtualItems()
    if (!items.length) return
    const last = items[items.length - 1]
    const total = rows().length
    if (
      props.hasMore &&
      !props.loadingMore &&
      last.index >= total - 6
    ) {
      props.onLoadMore()
    }
  })

  return (
    <div class="flex h-full flex-col">
      {/* Search — h-8 band */}
      <div class="flex h-10 shrink-0 items-center border-b border-border-2 px-3">
        <div class="relative w-full">
          <input
            type="text"
            placeholder="search events & markets… (/)"
            ref={(el) => props.ref?.(el)}
            value={props.filter}
            onInput={(e) => props.onFilterChange(e.currentTarget.value)}
            class="h-7 w-full border border-border-2 bg-panel px-2 text-[11px] text-text-bright outline-none placeholder:text-text-dimmer focus:border-border-3"
          />
          <Show when={props.filter}>
            <button
              onClick={() => props.onFilterChange('')}
              aria-label="clear"
              class="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer text-[12px] leading-none text-text-dim hover:text-text-bright"
            >
              ×
            </button>
          </Show>
        </div>
      </div>

      {/* Section header — h-8 */}
      <div class="section-head section-head-dense">
        <Show
          when={props.searching}
          fallback={<span>events · {props.events.length}</span>}
        >
          <span class="eyebrow-bright">
            search · {props.events.length} events
          </span>
        </Show>
        <span class="tabular-nums">{totalMarkets()} markets</span>
      </div>

      <Show when={rows().length === 0 && !props.searching && props.loadingMore}>
        <div class="flex-1 overflow-hidden">
          <For each={Array.from({ length: 8 })}>
            {() => (
              <div class="flex h-14 items-center gap-3 border-b border-border-2 px-3">
                <span class="w-3" />
                <div class="skeleton h-8 w-8 shrink-0" />
                <div class="flex-1 space-y-1.5">
                  <div class="skeleton h-3 w-5/6" />
                  <div class="skeleton h-2 w-1/3" />
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div
        ref={scrollRef!}
        class={
          'flex-1 overflow-y-auto ' +
          (rows().length === 0 && !props.searching && props.loadingMore
            ? 'hidden'
            : '')
        }
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
            width: '100%',
          }}
        >
          <For each={virtualizer.getVirtualItems()}>
            {(vi) => (
              <div
                data-index={vi.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${vi.start}px)`,
                  height: `${vi.size}px`,
                }}
              >
                <Show when={rows()[vi.index]}>
                  {(r) => (
                    <EventGroup
                      row={r()}
                      selectedMarketId={props.selectedMarketId}
                      onToggle={() => toggleEvent(r().event.id)}
                      onSelect={props.onSelect}
                    />
                  )}
                </Show>
              </div>
            )}
          </For>
        </div>
        {/* Inline end-of-list indicator — no sticky overlay */}
        <Show when={props.loadingMore || props.hasMore}>
          <div class="flex h-8 items-center justify-center border-t border-border text-[10px] uppercase tracking-[0.14em] text-text-dim">
            <Show when={props.loadingMore} fallback={<span>↓ more events</span>}>
              <span>loading…</span>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

function EventGroup(props: {
  row: Row
  selectedMarketId?: string
  onToggle: () => void
  onSelect: (m: Market) => void
}) {
  const innerScrolls = () =>
    props.row.expanded && props.row.markets.length > INNER_ROWS

  return (
    <div class="flex h-full flex-col">
      <button
        onClick={props.onToggle}
        class="flex h-14 w-full shrink-0 cursor-pointer items-center gap-3 border-b border-border-2 bg-panel px-3 text-left hover:bg-panel-2"
      >
        <Caret expanded={props.row.expanded} />
        <Avatar
          src={props.row.event.image ?? props.row.event.icon}
          seed={props.row.event.ticker || props.row.event.title}
          size="md"
        />
        <div class="min-w-0 flex-1">
          <div class="truncate text-[13px] font-semibold text-text-bright">
            {props.row.event.title}
          </div>
          <div class="mt-1 flex items-center gap-2 eyebrow">
            <span>{props.row.markets.length} outcomes</span>
            <span class="text-border-3">·</span>
            <span class="tabular-nums">
              {fmtUSD(props.row.event.volume24hr)} 24h
            </span>
          </div>
        </div>
      </button>
      <Show when={props.row.expanded}>
        <div
          class={
            'shrink-0 border-b border-border-2 ' +
            (innerScrolls() ? 'overflow-y-auto' : '')
          }
          style={{
            height: `${Math.min(props.row.markets.length, INNER_ROWS) * MARKET_H}px`,
          }}
          onWheel={(e) => {
            if (!innerScrolls()) return
            const el = e.currentTarget
            const atTop = el.scrollTop === 0 && e.deltaY < 0
            const atBottom =
              el.scrollTop + el.clientHeight >= el.scrollHeight - 1 &&
              e.deltaY > 0
            if (!atTop && !atBottom) e.stopPropagation()
          }}
        >
          <Index each={props.row.markets}>
            {(m) => (
              <MarketRow
                market={m()}
                selected={props.selectedMarketId === m().id}
                onClick={() => props.onSelect(m())}
              />
            )}
          </Index>
        </div>
      </Show>
    </div>
  )
}

function Caret(props: { expanded: boolean }) {
  return (
    <span
      class={
        'inline-block w-3 text-[10px] text-text-dim transition-transform duration-100 ' +
        (props.expanded ? 'rotate-90' : '')
      }
    >
      ▸
    </span>
  )
}

function MarketRow(props: {
  market: Market
  selected: boolean
  onClick: () => void
}) {
  const yesPrice = () => props.market.outcomePrices[0] ?? null
  const change = () => props.market.oneDayPriceChange ?? 0
  const fav = () => favorites.isMarket(props.market.id)
  return (
    <button
      onClick={props.onClick}
      style={{ height: `${MARKET_H}px` }}
      class={
        'relative flex w-full cursor-pointer items-center gap-3 border-b border-border pl-9 pr-3 text-left ' +
        (props.selected ? 'bg-panel-2' : 'hover:bg-panel')
      }
    >
      <Show when={props.selected}>
        <span class="absolute inset-y-0 left-0 w-0.5 bg-text-bright" />
      </Show>
      <Avatar
        src={props.market.image ?? props.market.icon}
        seed={props.market.groupItemTitle || props.market.question}
        size="sm"
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <Show when={fav()}>
            <span class="text-[9px] text-text-bright">★</span>
          </Show>
          <div class="truncate text-[11px] text-text">
            {props.market.groupItemTitle || props.market.question}
          </div>
        </div>
      </div>
      <div class="shrink-0 text-right leading-none">
        <div class="tabular-nums text-[13px] font-semibold text-text-bright">
          {yesPrice() != null ? `${(yesPrice()! * 100).toFixed(0)}¢` : '—'}
        </div>
        <Show when={change() !== 0}>
          <div
            class={
              'mt-1 tabular-nums text-[10px] ' +
              (change() > 0 ? 'text-up' : 'text-down')
            }
          >
            {change() > 0 ? '+' : ''}
            {(change() * 100).toFixed(1)}%
          </div>
        </Show>
      </div>
    </button>
  )
}

