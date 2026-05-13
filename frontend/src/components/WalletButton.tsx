import { Show, createSignal, onCleanup, onMount } from 'solid-js'
import { createQuery } from '@tanstack/solid-query'
import { useNavigate } from '@solidjs/router'
import { connect, disconnect, setTradingMode, shortAddr, wallet } from '../lib/wallet'
import { hasCachedCreds, listOpenOrders } from '../lib/polymarket'
import { OpenOrdersPanel } from './OpenOrdersPanel'

export function WalletButton() {
  const navigate = useNavigate()
  const [open, setOpen] = createSignal(false)
  const [ordersPanelOpen, setOrdersPanelOpen] = createSignal(false)
  let rootEl!: HTMLDivElement

  // Lightweight count poll so the header badge stays current without
  // mounting the full panel. 20s is plenty for a count indicator.
  const ordersCountQuery = createQuery(() => ({
    queryKey: ['open-orders', 'all', wallet.mode(), wallet.funder()],
    queryFn: () => listOpenOrders(),
    enabled: hasCachedCreds() && !!wallet.funder(),
    staleTime: 10_000,
    refetchInterval: 20_000,
  }))
  const orderCount = () => ordersCountQuery.data?.length ?? 0

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (open() && rootEl && !rootEl.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    onCleanup(() => document.removeEventListener('mousedown', onDocClick))
  })

  return (
    <div ref={rootEl!} class="relative">
      <Show
        when={wallet.isConnected()}
        fallback={
          <button
            onClick={connect}
            disabled={wallet.isConnecting()}
            class="h-7 border border-border-2 bg-panel px-3 text-[10px] uppercase tracking-[0.14em] text-text-bright hover:border-border-3 disabled:opacity-60"
          >
            {wallet.isConnecting() ? 'connecting…' : 'connect wallet'}
          </button>
        }
      >
        <button
          onClick={() => setOpen((v) => !v)}
          class="flex h-7 items-center gap-2 border border-border-2 bg-panel px-3 text-[10px] uppercase tracking-[0.14em] text-text-bright hover:border-border-3"
          title={wallet.eoa() ?? undefined}
        >
          <span class="inline-block h-1.5 w-1.5 bg-up" />
          <span class="tabular-nums normal-case tracking-normal">
            {shortAddr(wallet.eoa())}
          </span>
        </button>
        <Show when={open()}>
          <div class="absolute right-0 top-8 z-30 w-64 border border-border-3 bg-panel shadow-xl">
            <div class="border-b border-border-2 p-3 eyebrow">
              <div class="flex items-center justify-between">
                <span>EOA</span>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(wallet.eoa() ?? '')
                  }}
                  class="cursor-pointer normal-case tracking-normal text-text-dim hover:text-text-bright"
                  title="copy"
                >
                  copy
                </button>
              </div>
              <div class="mt-1 break-all normal-case font-mono text-[10px] tracking-normal text-text-bright">
                {wallet.eoa()}
              </div>
            </div>
            <div class="border-b border-border-2 p-3 eyebrow">
              <div class="flex items-center justify-between">
                <span>Polymarket Safe</span>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(wallet.safe() ?? '')
                  }}
                  class="cursor-pointer normal-case tracking-normal text-text-dim hover:text-text-bright"
                >
                  copy
                </button>
              </div>
              <div class="mt-1 break-all normal-case font-mono text-[10px] tracking-normal text-text-bright">
                {wallet.safe()}
              </div>
            </div>
            <button
              onClick={() => {
                setOpen(false)
                setOrdersPanelOpen(true)
              }}
              class="flex w-full items-center justify-between border-b border-border-2 px-3 py-2 text-left text-[11px] hover:bg-panel-2"
            >
              <span>open orders</span>
              <span class="tabular-nums text-text-dim">{orderCount()}</span>
            </button>
            <div class="border-b border-border-2 px-3 py-2 eyebrow">
              view positions
            </div>
            <button
              onClick={() => {
                setOpen(false)
                if (wallet.mode() !== 'eoa') setTradingMode('eoa')
                const e = wallet.eoa()
                if (e) navigate(`/trader/${e}`)
              }}
              class={
                'block w-full border-b border-border-2 px-3 py-2 text-left text-[11px] hover:bg-panel-2 ' +
                (wallet.mode() === 'eoa' ? 'text-text-bright' : 'text-text')
              }
            >
              EOA {wallet.mode() === 'eoa' ? '· active' : ''} →
            </button>
            <button
              onClick={() => {
                setOpen(false)
                if (wallet.mode() !== 'safe') setTradingMode('safe')
                const s = wallet.safe()
                if (s) navigate(`/trader/${s}`)
              }}
              class={
                'block w-full border-b border-border-2 px-3 py-2 text-left text-[11px] hover:bg-panel-2 ' +
                (wallet.mode() === 'safe' ? 'text-text-bright' : 'text-text')
              }
            >
              Polymarket Safe {wallet.mode() === 'safe' ? '· active' : ''} →
            </button>
            <button
              onClick={() => {
                setOpen(false)
                disconnect()
              }}
              class="block w-full px-3 py-2 text-left text-[11px] text-down hover:bg-panel-2"
            >
              Disconnect
            </button>
          </div>
        </Show>
      </Show>
      <Show when={wallet.error()}>
        <div class="absolute right-0 top-8 z-30 w-72 border border-down/60 bg-panel p-3 text-[10px] text-down shadow-xl">
          {wallet.error()}
        </div>
      </Show>
      <OpenOrdersPanel
        open={ordersPanelOpen()}
        onClose={() => setOrdersPanelOpen(false)}
      />
    </div>
  )
}
