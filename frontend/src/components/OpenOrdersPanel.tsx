import { For, Show, createMemo, createSignal } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import {
  createMutation,
  createQuery,
  useQueryClient,
} from '@tanstack/solid-query'
import { api } from '../lib/api'
import {
  cancelAllOpenOrders,
  cancelOrder,
  hasCachedCreds,
  listOpenOrders,
} from '../lib/polymarket'
import { wallet } from '../lib/wallet'
import { fmtNum, now, relativeTime } from '../lib/format'

type Props = {
  /** Caller controls visibility. Panel is a fixed-position overlay. */
  open: boolean
  onClose: () => void
}

/**
 * Cross-market open orders manager. Mounted by WalletButton; renders as a
 * full-height right-side sheet so a long list doesn't overflow the dropdown.
 *
 * Reads `listOpenOrders({})` (no market filter) on a 10s interval while open.
 * Clicking a row resolves the market by conditionId and navigates.
 */
export function OpenOrdersPanel(props: Props) {
  const navigate = useNavigate()
  const qc = useQueryClient()

  // Order list — only polls while panel is open.
  const ordersQuery = createQuery(() => ({
    queryKey: ['open-orders', 'all', wallet.mode(), wallet.funder()],
    queryFn: () => listOpenOrders(),
    enabled: props.open && hasCachedCreds() && !!wallet.funder(),
    staleTime: 5_000,
    refetchInterval: props.open ? 10_000 : false,
  }))

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['open-orders'] })
  }

  const cancelMut = createMutation(() => ({
    mutationFn: (id: string) => cancelOrder(id),
    onSuccess: invalidate,
  }))

  const [confirming, setConfirming] = createSignal(false)
  const cancelAllMut = createMutation(() => ({
    mutationFn: () => cancelAllOpenOrders(),
    onSuccess: () => {
      setConfirming(false)
      invalidate()
    },
    onError: () => setConfirming(false),
  }))

  // Resolve conditionId → slug on the fly. TanStack caches per cid.
  const navigateToMarket = async (conditionId: string) => {
    try {
      const cached = qc.getQueryData<{ slug?: string } | null>([
        'market-by-condition',
        conditionId,
      ])
      const slug =
        cached?.slug ??
        (
          await qc.fetchQuery({
            queryKey: ['market-by-condition', conditionId],
            queryFn: () => api.getMarketByConditionId(conditionId),
            staleTime: 5 * 60_000,
          })
        )?.slug
      if (slug) {
        navigate(`/market/${slug}`)
        props.onClose()
      }
    } catch {
      /* swallow — keep panel open so user sees the order didn't resolve */
    }
  }

  const orders = createMemo(() => ordersQuery.data ?? [])

  return (
    <Show when={props.open}>
      {/* Click-outside catcher */}
      <div
        class="fixed inset-0 z-40 bg-bg/60"
        onClick={props.onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-label="Open orders"
        class="fixed right-0 top-0 z-50 flex h-full w-[360px] flex-col border-l border-border-3 bg-panel shadow-2xl"
      >
        <header class="flex h-10 shrink-0 items-center justify-between border-b border-border-2 px-4">
          <span class="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-bright">
            open orders ({orders().length})
          </span>
          <button
            onClick={props.onClose}
            class="cursor-pointer text-[14px] leading-none text-text-dim hover:text-text-bright"
            aria-label="close"
          >
            ×
          </button>
        </header>

        <Show when={!hasCachedCreds()}>
          <div class="border-b border-border-2 p-4 text-[11px] text-text-dim">
            Connect a wallet and place at least one order to see open orders
            across markets here.
          </div>
        </Show>

        <Show when={hasCachedCreds() && orders().length === 0}>
          <div class="flex-1 p-4 text-[11px] text-text-dim">
            <Show
              when={!ordersQuery.isLoading}
              fallback={<span>loading…</span>}
            >
              no open orders
            </Show>
          </div>
        </Show>

        <div class="min-h-0 flex-1 overflow-y-auto">
          <For each={orders()}>
            {(o: any) => {
              const oid: string = o.id ?? o.order_id ?? ''
              const side: 'BUY' | 'SELL' = o.side === 'SELL' ? 'SELL' : 'BUY'
              const price = Number(o.price ?? 0)
              const orig = Number(o.original_size ?? 0)
              const matched = Number(o.size_matched ?? 0)
              const pct = orig > 0 ? (matched / orig) * 100 : 0
              const created = Number(o.created_at ?? 0)
              return (
                <div class="border-b border-border-2 px-4 py-2.5 text-[11px]">
                  <button
                    onClick={() => navigateToMarket(String(o.market))}
                    class="block w-full cursor-pointer text-left hover:text-text-bright"
                    title={`Navigate to market ${o.market}`}
                  >
                    <div class="flex items-center gap-2">
                      <span
                        class={
                          'font-semibold uppercase tracking-[0.14em] ' +
                          (side === 'BUY' ? 'text-up' : 'text-down')
                        }
                      >
                        {side} {o.outcome ?? ''}
                      </span>
                      <span class="text-text-dim">·</span>
                      <span class="tabular-nums text-text-bright">
                        {(price * 100).toFixed(2)}¢
                      </span>
                      <span class="ml-auto text-[10px] tabular-nums text-text-dim">
                        {created
                          ? relativeTime(new Date(created * 1000).toISOString())
                          : ''}
                      </span>
                    </div>
                    <div class="mt-1 truncate text-[10px] text-text-dim">
                      market {String(o.market).slice(0, 10)}…
                    </div>
                  </button>
                  <div class="mt-1.5 flex items-center justify-between">
                    <span class="tabular-nums text-text-dim">
                      {fmtNum(matched)}/{fmtNum(orig)} · {pct.toFixed(0)}%
                    </span>
                    <button
                      onClick={() => oid && cancelMut.mutate(oid)}
                      disabled={cancelMut.isPending || !oid}
                      class="cursor-pointer text-text-dim hover:text-down disabled:opacity-40"
                    >
                      cancel
                    </button>
                  </div>
                </div>
              )
            }}
          </For>
        </div>

        <Show when={hasCachedCreds() && orders().length > 0}>
          <footer class="shrink-0 border-t border-border-3 bg-panel-2 p-3">
            <Show
              when={confirming()}
              fallback={
                <button
                  onClick={() => setConfirming(true)}
                  class="h-8 w-full cursor-pointer border border-down text-[11px] font-semibold uppercase tracking-[0.14em] text-down hover:bg-down/15"
                >
                  cancel all
                </button>
              }
            >
              <div class="flex gap-2">
                <button
                  onClick={() => setConfirming(false)}
                  class="h-8 flex-1 cursor-pointer border border-border-2 text-[11px] uppercase tracking-[0.14em] text-text-dim hover:text-text-bright"
                >
                  keep
                </button>
                <button
                  onClick={() => cancelAllMut.mutate()}
                  disabled={cancelAllMut.isPending}
                  class="h-8 flex-1 cursor-pointer border border-down bg-down/15 text-[11px] font-semibold uppercase tracking-[0.14em] text-down hover:bg-down/25 disabled:opacity-60"
                >
                  {cancelAllMut.isPending
                    ? 'canceling…'
                    : `confirm · ${orders().length}`}
                </button>
              </div>
            </Show>
            <Show when={cancelAllMut.error}>
              <div class="mt-2 text-[10px] text-down">
                {(cancelAllMut.error as Error).message}
              </div>
            </Show>
          </footer>
        </Show>
        {/* Force re-render on minute tick so relativeTime stays fresh */}
        <span class="hidden">{now()}</span>
      </aside>
    </Show>
  )
}
