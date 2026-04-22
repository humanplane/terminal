import { For, Show } from 'solid-js'
import { createQuery } from '@tanstack/solid-query'
import { api, type UserTrade } from '../lib/api'
import { fmtNum, fmtUSDFull } from '../lib/format'

type Props = {
  conditionId?: string
}

export function TradesFeed(props: Props) {
  const tradesQ = createQuery(() => ({
    queryKey: ['market-trades', props.conditionId],
    queryFn: ({ signal }) =>
      api.marketTrades(props.conditionId!, { limit: 40 }, signal),
    enabled: !!props.conditionId,
    staleTime: 10_000,
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
  }))

  return (
    <div class="flex h-full flex-col">
      <div class="flex h-7 shrink-0 items-center justify-between border-b border-border px-3 eyebrow">
        <span>tape · recent trades</span>
        <Show when={tradesQ.isFetching && tradesQ.data}>
          <span class="text-text-bright">·</span>
        </Show>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show
          when={!tradesQ.isLoading}
          fallback={
            <div class="flex h-full items-center justify-center eyebrow">
              loading…
            </div>
          }
        >
          <Show
            when={(tradesQ.data ?? []).length}
            fallback={
              <div class="flex h-full items-center justify-center eyebrow">
                no recent trades
              </div>
            }
          >
            <div class="grid shrink-0 grid-cols-[44px_1fr_56px_70px_52px] gap-2 border-b border-border-subtle px-3 py-1 text-[9px] uppercase tracking-[0.14em] text-text-dim">
              <span>side</span>
              <span class="truncate">outcome</span>
              <span class="text-right">price</span>
              <span class="text-right">size</span>
              <span class="text-right">when</span>
            </div>
            <For each={tradesQ.data}>
              {(t) => <TradeLine t={t} />}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function TradeLine(props: { t: UserTrade }) {
  const sideCls = () => (props.t.side === 'BUY' ? 'text-up' : 'text-down')
  const outcomeCls = () => {
    const o = (props.t.outcome ?? '').toLowerCase()
    if (o === 'yes') return 'text-up'
    if (o === 'no') return 'text-down'
    return 'text-text'
  }
  return (
    <div
      class="grid grid-cols-[44px_1fr_56px_70px_52px] items-center gap-2 border-b border-border-subtle px-3 py-[3px] text-[11px] leading-[18px] hover:bg-panel"
      title={`${fmtUSDFull(props.t.size * props.t.price)} notional`}
    >
      <span class={'font-semibold tabular-nums ' + sideCls()}>
        {props.t.side}
      </span>
      <span class={'truncate ' + outcomeCls()}>{props.t.outcome}</span>
      <span class="text-right tabular-nums text-text-bright">
        {(props.t.price * 100).toFixed(2)}¢
      </span>
      <span class="text-right tabular-nums text-text">
        {fmtNum(props.t.size)}
      </span>
      <span class="text-right tabular-nums text-text-dim">
        {fmtRelative(props.t.timestamp)}
      </span>
    </div>
  )
}

function fmtRelative(ts: number) {
  if (!ts) return '—'
  const ms = ts * 1000 - Date.now()
  const abs = Math.abs(ms)
  if (abs < 60_000) return `${Math.max(1, Math.round(abs / 1000))}s`
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h`
  return `${Math.round(abs / 86_400_000)}d`
}
