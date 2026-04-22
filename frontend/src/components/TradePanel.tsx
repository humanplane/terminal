import { For, Show, createSignal } from 'solid-js'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { formatEther, formatUnits } from 'viem'
import type { Market } from '../lib/api'
import {
  cancelOrder,
  fetchUsdcStatus,
  isSafeDeployed,
  listOpenOrders,
  placeOrder,
  type PlaceOrderArgs,
} from '../lib/polymarket'
import { connect, getWalletClient, wallet } from '../lib/wallet'
import {
  MIN_MATIC_WEI,
  deploySafe,
  fetchMaticBalance,
  setupApprovals,
  waitForTx,
} from '../lib/safeSetup'
import { fmtNum, fmtUSDFull } from '../lib/format'

type Props = {
  market: Market
}

export function TradePanel(props: Props) {
  return (
    <Show
      when={wallet.isConnected()}
      fallback={
        <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <div class="eyebrow">Connect a wallet to trade</div>
          <button
            onClick={connect}
            disabled={wallet.isConnecting()}
            class="h-8 border border-border-3 bg-panel px-4 text-[11px] uppercase tracking-[0.14em] text-text-bright hover:bg-panel-2 disabled:opacity-60"
          >
            {wallet.isConnecting() ? 'connecting…' : 'connect wallet'}
          </button>
          <Show when={wallet.error()}>
            <div class="text-[10px] text-down">{wallet.error()}</div>
          </Show>
        </div>
      }
    >
      <ConnectedTradePanel market={props.market} />
    </Show>
  )
}

function ConnectedTradePanel(props: Props) {
  const qc = useQueryClient()
  const safe = () => wallet.safe()!

  const [side, setSide] = createSignal<'BUY' | 'SELL'>('BUY')
  const [priceStr, setPriceStr] = createSignal('')
  const [sizeStr, setSizeStr] = createSignal('')
  const [postOnly, setPostOnly] = createSignal(false)
  const [submitError, setSubmitError] = createSignal<string | null>(null)

  const yesToken = () => props.market.clobTokenIds[0]
  const noToken = () => props.market.clobTokenIds[1]
  const [outcomeIdx, setOutcomeIdx] = createSignal(0) // 0=Yes, 1=No

  const tokenId = () => (outcomeIdx() === 0 ? yesToken() : noToken())
  const outcomeLabel = () =>
    props.market.outcomes[outcomeIdx()] ?? (outcomeIdx() === 0 ? 'YES' : 'NO')

  // USDC status (only if on Polygon)
  const usdcQuery = createQuery(() => ({
    queryKey: ['usdc-status', safe()],
    queryFn: () => fetchUsdcStatus(safe()),
    enabled: wallet.onPolygon() && !!safe(),
    staleTime: 15_000,
    refetchInterval: 30_000,
  }))

  // Safe deployment — if the user has a fresh wallet that's never touched
  // Polymarket, their Safe proxy isn't deployed yet and trades will fail.
  const safeDeployedQuery = createQuery(() => ({
    queryKey: ['safe-deployed', safe()],
    queryFn: () => isSafeDeployed(safe()),
    enabled: wallet.onPolygon() && !!safe(),
    staleTime: 5 * 60_000,
  }))

  // EOA MATIC balance — we need ~0.3 MATIC for the init flow.
  const eoaAddress = () => wallet.eoa()!
  const maticQuery = createQuery(() => ({
    queryKey: ['matic-balance', eoaAddress()],
    queryFn: () => fetchMaticBalance(eoaAddress()),
    enabled: wallet.onPolygon() && !!wallet.eoa(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  }))

  const openOrdersQuery = createQuery(() => ({
    queryKey: ['open-orders', safe(), props.market.conditionId],
    queryFn: () => listOpenOrders({ market: props.market.conditionId }),
    enabled: !!safe(),
    staleTime: 5_000,
    refetchInterval: 10_000,
  }))

  const placeMut = createMutation(() => ({
    mutationFn: (args: PlaceOrderArgs) => placeOrder(args),
    onSuccess: () => {
      setSubmitError(null)
      setPriceStr('')
      setSizeStr('')
      qc.invalidateQueries({ queryKey: ['open-orders'] })
      qc.invalidateQueries({ queryKey: ['usdc-status'] })
    },
    onError: (e: Error) => setSubmitError(e.message),
  }))

  const cancelMut = createMutation(() => ({
    mutationFn: (id: string) => cancelOrder(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['open-orders'] })
    },
  }))

  // Init flow: deploy Safe (if needed) then apply all approvals.
  const [initStep, setInitStep] = createSignal<
    null | 'deploying' | 'approving'
  >(null)

  const initMut = createMutation(() => ({
    mutationFn: async () => {
      const wc = getWalletClient()
      if (!wc) throw new Error('wallet not available')
      const eoa = wallet.eoa()!
      const s = safe()

      // 1. Deploy Safe if missing.
      if (!safeDeployedQuery.data) {
        setInitStep('deploying')
        const deployHash = await deploySafe(wc, eoa)
        await waitForTx(deployHash)
        await qc.invalidateQueries({ queryKey: ['safe-deployed'] })
      }

      // 2. Apply approvals.
      setInitStep('approving')
      const approveHash = await setupApprovals(wc, eoa, s)
      await waitForTx(approveHash)
    },
    onSettled: () => {
      setInitStep(null)
      qc.invalidateQueries({ queryKey: ['safe-deployed'] })
      qc.invalidateQueries({ queryKey: ['usdc-status'] })
      qc.invalidateQueries({ queryKey: ['matic-balance'] })
    },
  }))

  const needsInit = () => {
    if (safeDeployedQuery.data === false) return true
    // If deployed but allowance is zero, we still need the approval batch.
    const u = usdcQuery.data
    if (!u) return false
    return (
      u.ctfExchange === 0n &&
      u.negRiskExchange === 0n &&
      u.negRiskAdapter === 0n
    )
  }

  const hasEnoughMatic = () => {
    const b = maticQuery.data
    return b != null && b >= MIN_MATIC_WEI
  }

  const tickSize = () => props.market.orderPriceMinTickSize ?? 0.01
  const minSize = () => props.market.orderMinSize ?? (props.market.negRisk ? 1 : 5)

  const rawPriceDec = () => {
    const n = Number(priceStr())
    if (!Number.isFinite(n)) return NaN
    return n / 100 // UI is in cents, CLOB wants 0-1 decimal
  }
  /** Price snapped to the market's tick size (required by CLOB). */
  const priceDec = () => {
    const p = rawPriceDec()
    if (!Number.isFinite(p)) return NaN
    const t = tickSize()
    return Math.round(p / t) * t
  }
  const size = () => Number(sizeStr())

  const totalCost = () => {
    const p = priceDec()
    const s = size()
    if (!Number.isFinite(p) || !Number.isFinite(s)) return 0
    return p * s
  }

  const validation = (): string | null => {
    const p = priceDec()
    const s = size()
    if (!Number.isFinite(p) || p <= 0 || p >= 1)
      return 'price must be between 0 and 100¢'
    if (!Number.isFinite(s) || s < minSize())
      return `size must be ≥ ${minSize()}`
    if (!wallet.onPolygon()) return 'wallet must be on Polygon'
    if (side() === 'BUY') {
      // Integer-safe USDC comparison (USDC has 6 decimals).
      const needed =
        BigInt(Math.round(priceDec() * 1_000_000)) *
        BigInt(Math.max(1, Math.floor(s)))
      if (usdcQuery.data && usdcQuery.data.balance < needed) {
        return `insufficient USDC (have ${formatUnits(usdcQuery.data.balance, 6)})`
      }
    }
    return null
  }

  const submit = () => {
    const v = validation()
    if (v) {
      setSubmitError(v)
      return
    }
    setSubmitError(null)
    placeMut.mutate({
      tokenId: tokenId()!,
      side: side(),
      price: priceDec(),
      size: size(),
      tickSize: tickSize(),
      negRisk: props.market.negRisk,
      orderType: 'GTC',
      postOnly: postOnly(),
    })
  }

  /** Allowance against the exchange this specific market trades through. */
  const exchangeAllowance = (): bigint => {
    const u = usdcQuery.data
    if (!u) return 0n
    if (props.market.negRisk) {
      // Neg-risk trading requires allowance on the neg-risk exchange AND the
      // adapter — the binding constraint is the smaller of the two.
      return u.negRiskExchange < u.negRiskAdapter
        ? u.negRiskExchange
        : u.negRiskAdapter
    }
    return u.ctfExchange
  }

  /**
   * Only warn about approvals when the user *would actually be blocked* by
   * the current trade size. Previously we compared against an arbitrary 1M-
   * USDC threshold which fired for anyone with less than `MaxUint256`.
   *
   * For SELL orders we don't need USDC allowance at all (proceeds flow in),
   * but the CTF ERC1155 setApprovalForAll is a separate requirement — we
   * can't read that without an extra RPC call, so we defer signalling for
   * SELLs and let the CLOB reject with a clear error.
   */
  const approvalShortfall = (): bigint | null => {
    if (side() === 'SELL') return null
    const costRaw = BigInt(
      Math.round((Number.isFinite(totalCost()) ? totalCost() : 0) * 1_000_000)
    )
    if (costRaw === 0n) return null
    const have = exchangeAllowance()
    return have < costRaw ? costRaw - have : null
  }

  return (
    <div class="flex h-full flex-col overflow-y-auto">
      {/* One-shot initialize flow — deploy Safe + apply all approvals from
          the user's EOA. One-time cost ~0.2 MATIC; no relayer needed. */}
      <Show when={needsInit()}>
        <div class="border-b border-border-3 bg-panel-2 p-3">
          <div class="eyebrow text-text-bright">initialize trading</div>
          <p class="mt-1.5 text-[11px] leading-snug text-text">
            {safeDeployedQuery.data === false
              ? 'Deploy your Polymarket Safe, then approve USDC + CTF spending.'
              : 'Approve USDC + CTF spending to unlock trading.'}
            {' '}One-time setup, costs ~0.2 MATIC in gas.
          </p>
          <Show
            when={hasEnoughMatic()}
            fallback={
              <div class="mt-2 text-[10px] leading-snug text-down">
                You have{' '}
                <span class="tabular-nums">
                  {maticQuery.data != null
                    ? Number(formatEther(maticQuery.data)).toFixed(4)
                    : '—'}
                </span>{' '}
                MATIC on your EOA ({wallet.eoa()?.slice(0, 6)}…). Send at
                least 0.3 MATIC to this address to continue. Polygon gas is
                cheap but this wallet currently has too little.
              </div>
            }
          >
            <button
              onClick={() => initMut.mutate()}
              disabled={initMut.isPending}
              class="mt-2 h-8 w-full cursor-pointer border border-text-bright bg-text-bright text-[11px] font-semibold uppercase tracking-[0.14em] text-bg hover:bg-text hover:border-text disabled:opacity-60"
            >
              {initStep() === 'deploying'
                ? 'deploying safe… (1/2)'
                : initStep() === 'approving'
                  ? 'approving… (2/2)'
                  : safeDeployedQuery.data === false
                    ? 'initialize (2 txs)'
                    : 'approve (1 tx)'}
            </button>
          </Show>
          <Show when={initMut.error}>
            <div class="mt-2 text-[10px] text-down">
              {(initMut.error as Error).message}
            </div>
          </Show>
        </div>
      </Show>

      {/* USDC + allowance status */}
      <div class="border-b border-border-2 px-4 py-3">
        <div class="flex items-center justify-between eyebrow">
          <span>USDC balance</span>
          <Show when={usdcQuery.data} fallback={<span>—</span>}>
            <span class="tabular-nums text-text-bright normal-case tracking-normal">
              ${Number(formatUnits(usdcQuery.data!.balance, 6)).toFixed(2)}
            </span>
          </Show>
        </div>
        <Show when={usdcQuery.data}>
          <div class="mt-1 flex items-center justify-between eyebrow">
            <span>allowance</span>
            <span class="tabular-nums text-text normal-case tracking-normal">
              <Show
                when={
                  exchangeAllowance() > BigInt('1000000000000000000000000')
                }
                fallback={
                  <>${Number(formatUnits(exchangeAllowance(), 6)).toFixed(2)}</>
                }
              >
                ∞
              </Show>
            </span>
          </div>
        </Show>
        <Show when={approvalShortfall() != null}>
          <div class="mt-2 border border-down/60 p-2 text-[10px] leading-snug text-down">
            This trade needs ${(
              Number(formatUnits(approvalShortfall()!, 6))
            ).toFixed(2)} more USDC approved
            {props.market.negRisk ? ' (neg-risk exchange + adapter)' : ''}.{' '}
            Polymarket's approvals are Safe-exec transactions relayed via their
            backend —{' '}
            <a
              href={`https://polymarket.com/markets/${props.market.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              class="underline hover:text-text-bright"
            >
              open on polymarket.com
            </a>{' '}
            once to set them up (done in-wallet, takes one signature).
          </div>
        </Show>
      </div>

      {/* Outcome selector (only meaningful for binary markets) */}
      <div class="flex h-8 shrink-0 items-center gap-3 border-b border-border-2 px-4 eyebrow">
        <span>outcome</span>
        <div class="segmented">
          <button
            data-active={outcomeIdx() === 0}
            onClick={() => setOutcomeIdx(0)}
          >
            {props.market.outcomes[0] ?? 'Yes'}
          </button>
          <Show when={noToken()}>
            <button
              data-active={outcomeIdx() === 1}
              onClick={() => setOutcomeIdx(1)}
            >
              {props.market.outcomes[1] ?? 'No'}
            </button>
          </Show>
        </div>
      </div>

      {/* Side toggle */}
      <div class="flex h-8 shrink-0 items-center justify-between border-b border-border-2 px-4 eyebrow">
        <span>side</span>
        <div class="segmented">
          <button data-active={side() === 'BUY'} onClick={() => setSide('BUY')}>
            Buy
          </button>
          <button
            data-active={side() === 'SELL'}
            onClick={() => setSide('SELL')}
          >
            Sell
          </button>
        </div>
      </div>

      {/* Price + size */}
      <div class="grid shrink-0 grid-cols-2 gap-0 border-b border-border-2">
        <label class="flex flex-col border-r border-border-2 px-4 py-3">
          <span class="eyebrow">price ¢</span>
          <input
            type="number"
            step="0.1"
            min="0"
            max="100"
            placeholder="50.0"
            value={priceStr()}
            onInput={(e) => setPriceStr(e.currentTarget.value)}
            class="mt-1 bg-transparent tabular-nums text-[15px] font-semibold text-text-bright outline-none placeholder:text-text-dimmer"
          />
        </label>
        <label class="flex flex-col px-4 py-3">
          <span class="eyebrow">shares</span>
          <input
            type="number"
            step="1"
            min="1"
            placeholder="100"
            value={sizeStr()}
            onInput={(e) => setSizeStr(e.currentTarget.value)}
            class="mt-1 bg-transparent tabular-nums text-[15px] font-semibold text-text-bright outline-none placeholder:text-text-dimmer"
          />
        </label>
      </div>

      {/* Totals + post-only */}
      <div class="flex h-8 shrink-0 items-center justify-between border-b border-border-2 px-4 eyebrow">
        <label class="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={postOnly()}
            onChange={(e) => setPostOnly(e.currentTarget.checked)}
          />
          <span>post-only</span>
        </label>
        <div class="flex items-center gap-3 normal-case tracking-normal">
          <Show when={Number.isFinite(priceDec()) && priceDec() > 0}>
            <span class="text-text-dim">
              snap{' '}
              <span class="tabular-nums text-text-bright">
                {(priceDec() * 100).toFixed(2)}¢
              </span>
            </span>
          </Show>
          <span class="tabular-nums text-text-bright">
            total {fmtUSDFull(totalCost())}
          </span>
        </div>
      </div>

      {/* Submit */}
      <div class="shrink-0 border-b border-border-2 px-4 py-3">
        <button
          onClick={submit}
          disabled={placeMut.isPending}
          class={
            'h-9 w-full cursor-pointer border text-[12px] font-semibold uppercase tracking-[0.14em] disabled:opacity-60 ' +
            (side() === 'BUY'
              ? 'border-up/60 bg-up/10 text-up hover:bg-up/20'
              : 'border-down/60 bg-down/10 text-down hover:bg-down/20')
          }
        >
          {placeMut.isPending
            ? 'signing…'
            : `${side()} ${outcomeLabel()}`}
        </button>
        <Show when={submitError()}>
          <div class="mt-2 text-[10px] text-down">{submitError()}</div>
        </Show>
      </div>

      {/* Open orders */}
      <div class="flex min-h-0 flex-col">
        <div class="flex h-7 shrink-0 items-center justify-between border-b border-border px-4 eyebrow">
          <span>open orders</span>
          <span class="tabular-nums">
            {openOrdersQuery.data?.length ?? 0}
          </span>
        </div>
        <Show
          when={!openOrdersQuery.isLoading}
          fallback={<div class="p-3 eyebrow">loading…</div>}
        >
          <Show
            when={(openOrdersQuery.data ?? []).length}
            fallback={<div class="p-3 eyebrow">no open orders</div>}
          >
            <For each={openOrdersQuery.data}>
              {(o: any) => {
                // SDK responses vary between id / order_id / orderId; accept all.
                const oid = (): string =>
                  o.id ?? o.order_id ?? o.orderId ?? ''
                return (
                  <div class="grid grid-cols-[48px_1fr_1fr_60px] items-center gap-3 border-b border-border px-4 py-2 text-[11px]">
                    <span
                      class={
                        'font-semibold uppercase ' +
                        (o.side === 'BUY' ? 'text-up' : 'text-down')
                      }
                    >
                      {o.side}
                    </span>
                    <span class="tabular-nums">
                      {(Number(o.price) * 100).toFixed(1)}¢
                    </span>
                    <span class="tabular-nums text-text-dim">
                      {fmtNum(Number(o.size_matched ?? 0))}/
                      {fmtNum(Number(o.original_size ?? o.size ?? 0))}
                    </span>
                    <button
                      onClick={() => {
                        const id = oid()
                        if (id) cancelMut.mutate(id)
                      }}
                      disabled={cancelMut.isPending || !oid()}
                      class="cursor-pointer text-right text-text-dim hover:text-down disabled:opacity-40"
                    >
                      cancel
                    </button>
                  </div>
                )
              }}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}
