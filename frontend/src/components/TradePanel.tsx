import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import {
  createMutation,
  createQuery,
  useQueryClient,
} from '@tanstack/solid-query'
import { formatEther, formatUnits } from 'viem'
import type { Market } from '../lib/api'
import {
  approveUsdcFromEOA,
  cancelOrder,
  fetchUsdcStatus,
  hasCachedCreds,
  isCtfApprovedForAll,
  isSafeDeployed,
  listOpenOrders,
  placeOrder,
  setCtfApprovalForAllFromEOA,
  USDC_SPENDERS,
  type PlaceOrderArgs,
} from '../lib/polymarket'
import {
  connect,
  getWalletClient,
  setTradingMode,
  wallet,
} from '../lib/wallet'
import {
  MIN_MATIC_WEI,
  deploySafe,
  fetchMaticBalance,
  setupApprovals,
  waitForTx,
} from '../lib/safeSetup'
import { fmtNum } from '../lib/format'
import type { SortedLevel } from '../lib/stream'

type Props = {
  market: Market
  /** Pre-sorted YES-token order book (best first). Used to compute limit
   *  auto-fill and market-order fill previews without hitting the network. */
  bids: () => SortedLevel[]
  asks: () => SortedLevel[]
}

/** Default slippage for market orders: 2% (matches humanplane + Polymarket UI). */
const MARKET_SLIPPAGE = 0.02

type OrderKind = 'market' | 'limit'

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
      <ConnectedTradePanel {...props} />
    </Show>
  )
}

function ConnectedTradePanel(props: Props) {
  const qc = useQueryClient()
  const funder = () => wallet.funder()!
  const safe = () => wallet.safe()!

  // --- form state -------------------------------------------------------
  const [kind, setKind] = createSignal<OrderKind>('market')
  const [side, setSide] = createSignal<'BUY' | 'SELL'>('BUY')
  const [outcomeIdx, setOutcomeIdx] = createSignal(0) // 0 = YES, 1 = NO
  const [amountStr, setAmountStr] = createSignal('')
  const [priceStr, setPriceStr] = createSignal('')
  const [postOnly, setPostOnly] = createSignal(false)
  const [submitError, setSubmitError] = createSignal<string | null>(null)
  const [lastOk, setLastOk] = createSignal<string | null>(null)

  const yesToken = () => props.market.clobTokenIds[0]
  const noToken = () => props.market.clobTokenIds[1]
  const tokenId = () => (outcomeIdx() === 0 ? yesToken() : noToken())
  const outcomeLabel = () =>
    props.market.outcomes[outcomeIdx()] ?? (outcomeIdx() === 0 ? 'YES' : 'NO')

  const tickSize = () => props.market.orderPriceMinTickSize ?? 0.01
  const minSize = () => props.market.orderMinSize ?? (props.market.negRisk ? 1 : 5)

  // --- book views (YES-native, derived for NO) --------------------------
  //
  // Polymarket publishes separate books per outcome token, but our SSE
  // subscription is for the YES token. NO prices are the complement of YES
  // prices: if someone bids for NO at 40¢ they're implicitly offering to
  // sell YES at 60¢. For limit-auto-fill this derivation is exact; for
  // market-order submission the SDK refetches the correct book per token.

  const bidsForOutcome = (): SortedLevel[] => {
    if (outcomeIdx() === 0) return props.bids()
    // NO bids ≈ complement of YES asks
    return props.asks().map((a) => ({ price: 1 - a.price, size: a.size }))
  }
  const asksForOutcome = (): SortedLevel[] => {
    if (outcomeIdx() === 0) return props.asks()
    return props.bids().map((b) => ({ price: 1 - b.price, size: b.size }))
  }

  const bestBid = (): number | null =>
    bidsForOutcome()[0]?.price ?? null
  const bestAsk = (): number | null =>
    asksForOutcome()[0]?.price ?? null

  // Auto-fill the limit price when the user first opens the form (or
  // switches side / outcome), but don't clobber a user-typed value.
  let userTypedPrice = false
  createEffect(() => {
    void side() // re-evaluate on side change
    void outcomeIdx()
    void kind()
    if (userTypedPrice) return
    if (kind() !== 'limit') return
    const p = side() === 'BUY' ? bestAsk() : bestBid()
    if (p != null) setPriceStr((p * 100).toFixed(2))
  })

  // --- USDC + approvals + safe deployment -------------------------------
  const usdcQuery = createQuery(() => ({
    queryKey: ['usdc-status', wallet.mode(), funder()],
    queryFn: () => fetchUsdcStatus(funder()),
    enabled: wallet.onPolygon() && !!funder(),
    staleTime: 15_000,
    refetchInterval: 30_000,
  }))

  const safeDeployedQuery = createQuery(() => ({
    queryKey: ['safe-deployed', safe()],
    queryFn: () => isSafeDeployed(safe()),
    enabled: wallet.onPolygon() && !!safe() && wallet.mode() === 'safe',
    staleTime: 5 * 60_000,
  }))

  const eoaAddress = () => wallet.eoa()!
  const maticQuery = createQuery(() => ({
    queryKey: ['matic-balance', eoaAddress()],
    queryFn: () => fetchMaticBalance(eoaAddress()),
    enabled: wallet.onPolygon() && !!wallet.eoa(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  }))

  const ctfApprovalsQuery = createQuery(() => ({
    queryKey: ['ctf-approvals', wallet.mode(), funder()],
    queryFn: async () => {
      const f = funder()
      const [ctfEx, negEx, negAdap] = await Promise.all([
        isCtfApprovedForAll(f, USDC_SPENDERS.ctfExchange),
        isCtfApprovedForAll(f, USDC_SPENDERS.negRiskExchange),
        isCtfApprovedForAll(f, USDC_SPENDERS.negRiskAdapter),
      ])
      return { ctfExchange: ctfEx, negRiskExchange: negEx, negRiskAdapter: negAdap }
    },
    enabled: wallet.onPolygon() && !!funder(),
    staleTime: 60_000,
    refetchInterval: 120_000,
  }))

  const openOrdersQuery = createQuery(() => ({
    queryKey: ['open-orders', wallet.mode(), funder(), props.market.conditionId],
    queryFn: () => listOpenOrders({ market: props.market.conditionId }),
    enabled: !!funder() && hasCachedCreds(),
    staleTime: 5_000,
    refetchInterval: 10_000,
  }))

  // --- mutations --------------------------------------------------------
  const placeMut = createMutation(() => ({
    mutationFn: (args: PlaceOrderArgs) => placeOrder(args),
    onSuccess: (resp: any) => {
      setSubmitError(null)
      setAmountStr('')
      const id = resp?.orderID ?? resp?.order_id ?? resp?.orderId ?? ''
      setLastOk(
        id
          ? `Order placed · ${shortHash(String(id))}`
          : 'Order placed'
      )
      qc.invalidateQueries({ queryKey: ['open-orders'] })
      qc.invalidateQueries({ queryKey: ['usdc-status'] })
    },
    onError: (e: Error) => {
      setLastOk(null)
      setSubmitError(e.message)
    },
  }))

  const cancelMut = createMutation(() => ({
    mutationFn: (id: string) => cancelOrder(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['open-orders'] }),
  }))

  // --- init / approvals flow (unchanged semantics) ----------------------
  const [initStep, setInitStep] = createSignal<string | null>(null)
  const initMut = createMutation(() => ({
    mutationFn: async () => {
      const wc = getWalletClient()
      if (!wc) throw new Error('wallet not available')
      const eoa = wallet.eoa()!
      const modeAtStart = wallet.mode()
      const assertMode = () => {
        if (wallet.mode() !== modeAtStart)
          throw new Error('Trading mode changed — please retry')
      }

      if (modeAtStart === 'safe') {
        const s = safe()
        if (!safeDeployedQuery.data) {
          setInitStep('deploying safe…')
          await waitForTx(await deploySafe(wc, eoa))
          assertMode()
          await qc.invalidateQueries({ queryKey: ['safe-deployed'] })
        }
        setInitStep('approving…')
        await waitForTx(await setupApprovals(wc, eoa, s))
        return
      }

      const u = usdcQuery.data
      const ctfA = ctfApprovalsQuery.data
      const usdcTargets: Array<`0x${string}`> = []
      if (!u || u.ctfExchange === 0n) usdcTargets.push(USDC_SPENDERS.ctfExchange)
      if (!u || u.negRiskExchange === 0n)
        usdcTargets.push(USDC_SPENDERS.negRiskExchange)
      if (!u || u.negRiskAdapter === 0n)
        usdcTargets.push(USDC_SPENDERS.negRiskAdapter)
      const ctfTargets: Array<`0x${string}`> = []
      if (!ctfA || !ctfA.ctfExchange)
        ctfTargets.push(USDC_SPENDERS.ctfExchange)
      if (!ctfA || !ctfA.negRiskExchange)
        ctfTargets.push(USDC_SPENDERS.negRiskExchange)
      if (!ctfA || !ctfA.negRiskAdapter)
        ctfTargets.push(USDC_SPENDERS.negRiskAdapter)
      const total = usdcTargets.length + ctfTargets.length
      let n = 0
      for (const t of usdcTargets) {
        n++
        assertMode()
        setInitStep(`approving USDC ${n}/${total}`)
        await waitForTx(await approveUsdcFromEOA(t))
      }
      for (const t of ctfTargets) {
        n++
        assertMode()
        setInitStep(`approving shares ${n}/${total}`)
        await waitForTx(await setCtfApprovalForAllFromEOA(t))
      }
    },
    onSettled: () => {
      setInitStep(null)
      qc.invalidateQueries({ queryKey: ['safe-deployed'] })
      qc.invalidateQueries({ queryKey: ['usdc-status'] })
      qc.invalidateQueries({ queryKey: ['matic-balance'] })
      qc.invalidateQueries({ queryKey: ['ctf-approvals'] })
    },
  }))

  const needsInit = () => {
    if (wallet.mode() === 'safe' && safeDeployedQuery.data === false) return true
    const u = usdcQuery.data
    const ctfA = ctfApprovalsQuery.data
    if (!u || !ctfA) return false
    const anyUsdc =
      u.ctfExchange === 0n || u.negRiskExchange === 0n || u.negRiskAdapter === 0n
    const anyCtf =
      !ctfA.ctfExchange || !ctfA.negRiskExchange || !ctfA.negRiskAdapter
    return anyUsdc || anyCtf
  }

  const hasEnoughMatic = () => {
    const b = maticQuery.data
    return b != null && b >= MIN_MATIC_WEI
  }

  // --- amount / price parsing -------------------------------------------
  const amount = () => {
    const n = Number(amountStr())
    return Number.isFinite(n) ? n : NaN
  }
  const priceDec = () => {
    const n = Number(priceStr())
    if (!Number.isFinite(n)) return NaN
    const t = tickSize()
    return Math.round(n / 100 / t) * t
  }

  // --- market preview (computed locally from live book) -----------------
  /**
   * Walk the book to estimate fill. For a market BUY the amount is USDC to
   * spend; for a market SELL it's shares. Returns the average and worst
   * fill prices plus filled shares (BUY) or USDC received (SELL).
   */
  const marketPreview = createMemo<null | {
    avgPrice: number
    worstPrice: number
    fillable: number // shares (BUY) or USDC (SELL)
    partial: boolean
  }>(() => {
    if (kind() !== 'market') return null
    const a = amount()
    if (!Number.isFinite(a) || a <= 0) return null
    const isBuy = side() === 'BUY'
    const levels = isBuy ? asksForOutcome() : bidsForOutcome()
    if (!levels.length) return null

    let remainingUSDC = isBuy ? a : 0
    let remainingShares = isBuy ? 0 : a
    let filledShares = 0
    let filledUSDC = 0
    let worst = 0
    for (const lvl of levels) {
      const levelSize = lvl.size // shares at this price
      if (isBuy) {
        const cost = levelSize * lvl.price
        const spend = Math.min(remainingUSDC, cost)
        if (spend <= 0) break
        filledShares += spend / lvl.price
        filledUSDC += spend
        remainingUSDC -= spend
        worst = lvl.price
        if (remainingUSDC <= 0) break
      } else {
        const takeShares = Math.min(remainingShares, levelSize)
        if (takeShares <= 0) break
        filledShares += takeShares
        filledUSDC += takeShares * lvl.price
        remainingShares -= takeShares
        worst = lvl.price
        if (remainingShares <= 0) break
      }
    }
    if (filledShares === 0) return null
    const avgPrice = filledUSDC / filledShares
    const partial = isBuy ? remainingUSDC > 0.001 : remainingShares > 0.001
    return {
      avgPrice,
      worstPrice: worst,
      fillable: isBuy ? filledShares : filledUSDC,
      partial,
    }
  })

  /** Slippage-protected price submitted with market orders. */
  const marketWorstPrice = (): number | null => {
    const mp = marketPreview()
    if (!mp) return null
    const raw =
      side() === 'BUY'
        ? mp.avgPrice * (1 + MARKET_SLIPPAGE)
        : mp.avgPrice * (1 - MARKET_SLIPPAGE)
    // Clamp to tick + [tick, 1-tick]
    const t = tickSize()
    const snapped = Math.round(raw / t) * t
    const max = 1 - t
    return Math.max(t, Math.min(max, snapped))
  }

  // --- submit -----------------------------------------------------------
  const validation = (): string | null => {
    if (!wallet.onPolygon()) return 'wallet must be on Polygon'
    const a = amount()
    if (!Number.isFinite(a) || a <= 0) return 'enter an amount'

    if (kind() === 'limit') {
      const p = priceDec()
      if (!Number.isFinite(p) || p <= 0 || p >= 1)
        return 'price must be between 0 and 100¢'
      if (a < minSize()) return `size must be ≥ ${minSize()} shares`
    } else {
      // Market mode: for BUY `a` is USDC; for SELL `a` is shares.
      if (side() === 'SELL' && a < minSize())
        return `size must be ≥ ${minSize()} shares`
      const mp = marketPreview()
      if (!mp || mp.fillable <= 0) return 'no liquidity at this size'
      if (mp.partial) return 'not enough book depth for this size'
    }

    // USDC balance check on BUY orders.
    if (side() === 'BUY') {
      const needUsdc =
        kind() === 'market' ? a : priceDec() * a
      const needed = BigInt(Math.round(needUsdc * 1_000_000))
      if (usdcQuery.data && usdcQuery.data.balance < needed) {
        return `insufficient USDC (have ${Number(formatUnits(usdcQuery.data.balance, 6)).toFixed(2)})`
      }
    }
    return null
  }

  const submit = () => {
    setLastOk(null)
    const v = validation()
    if (v) {
      setSubmitError(v)
      return
    }
    setSubmitError(null)
    const a = amount()
    if (kind() === 'limit') {
      placeMut.mutate({
        tokenId: tokenId()!,
        side: side(),
        price: priceDec(),
        size: a,
        tickSize: tickSize(),
        negRisk: props.market.negRisk,
        orderType: 'GTC',
        postOnly: postOnly(),
      })
    } else {
      // Market order — FAK (fill-and-kill; partial fills allowed).
      // For BUY the SDK expects `size` to represent the USDC amount; for
      // SELL it's shares. Our placeOrder() already handles this.
      placeMut.mutate({
        tokenId: tokenId()!,
        side: side(),
        price: marketWorstPrice()!,
        size: a,
        tickSize: tickSize(),
        negRisk: props.market.negRisk,
        orderType: 'FAK',
      })
    }
  }

  // --- presets ----------------------------------------------------------
  const amountLabel = () =>
    kind() === 'market' && side() === 'BUY' ? 'USDC' : 'shares'
  const amountUnit = () =>
    kind() === 'market' && side() === 'BUY' ? '$' : ''

  const presets = () =>
    kind() === 'market' && side() === 'BUY'
      ? [5, 10, 50, 100] // USDC
      : [10, 50, 100, 500] // shares

  const submitLabel = () => {
    const a = amount()
    if (kind() === 'market') {
      const mp = marketPreview()
      if (mp && Number.isFinite(a)) {
        const sharesStr =
          side() === 'BUY'
            ? fmtNum(mp.fillable)
            : fmtNum(a)
        const avg = (mp.avgPrice * 100).toFixed(1)
        return `${side()} ${sharesStr} ${outcomeLabel()} @ ~${avg}¢`
      }
      return `${side()} at market`
    }
    if (!Number.isFinite(a) || a <= 0) return `${side()} ${outcomeLabel()} (limit)`
    const total = a * priceDec()
    return `${side()} ${fmtNum(a)} ${outcomeLabel()} @ ${(priceDec() * 100).toFixed(1)}¢ · $${total.toFixed(2)}`
  }

  return (
    <div class="flex h-full flex-col overflow-y-auto">
      {/* Mode toggle (EOA / Safe) */}
      <div class="flex h-7 shrink-0 items-center justify-between border-b border-border-2 px-4 eyebrow">
        <span>funds on</span>
        <div class="segmented">
          <button
            data-active={wallet.mode() === 'eoa'}
            onClick={() => setTradingMode('eoa')}
          >
            EOA
          </button>
          <button
            data-active={wallet.mode() === 'safe'}
            onClick={() => setTradingMode('safe')}
          >
            Safe
          </button>
        </div>
      </div>

      {/* USDC + allowance */}
      <div class="border-b border-border-2 px-4 py-2.5">
        <div class="flex items-center justify-between eyebrow">
          <span>USDC balance</span>
          <Show when={usdcQuery.data} fallback={<span>—</span>}>
            <span class="tabular-nums text-text-bright normal-case tracking-normal">
              ${Number(formatUnits(usdcQuery.data!.balance, 6)).toFixed(2)}
            </span>
          </Show>
        </div>
      </div>

      {/* Init banner */}
      <Show when={needsInit()}>
        <div class="border-b border-border-3 bg-panel-2 p-3">
          <div class="eyebrow text-text-bright">initialize trading</div>
          <p class="mt-1.5 text-[11px] leading-snug text-text">
            <Show
              when={wallet.mode() === 'eoa'}
              fallback={
                safeDeployedQuery.data === false
                  ? 'Deploy your Safe then approve spending (~0.2 MATIC, 2 txs).'
                  : 'Approve USDC + CTF via your Safe (~0.15 MATIC, 1 tx).'
              }
            >
              Approve USDC + CTF spending from your EOA. Up to 6 quick txs.
            </Show>
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
                MATIC. Send ~0.3 MATIC to {wallet.eoa()?.slice(0, 6)}… on
                Polygon to continue.
              </div>
            }
          >
            <button
              onClick={() => initMut.mutate()}
              disabled={initMut.isPending}
              class="mt-2 h-8 w-full cursor-pointer border border-text-bright bg-text-bright text-[11px] font-semibold uppercase tracking-[0.14em] text-bg hover:bg-text hover:border-text disabled:opacity-60"
            >
              {initStep() ?? 'initialize trading'}
            </button>
          </Show>
          <Show when={initMut.error}>
            <div class="mt-2 text-[10px] text-down">
              {(initMut.error as Error).message}
            </div>
          </Show>
        </div>
      </Show>

      {/* Order type */}
      <div class="flex h-8 shrink-0 items-center justify-between border-b border-border-2 px-4 eyebrow">
        <span>type</span>
        <div class="segmented">
          <button
            data-active={kind() === 'market'}
            onClick={() => {
              userTypedPrice = false
              setKind('market')
            }}
          >
            Market
          </button>
          <button
            data-active={kind() === 'limit'}
            onClick={() => {
              userTypedPrice = false
              setKind('limit')
            }}
          >
            Limit
          </button>
        </div>
      </div>

      {/* Outcome */}
      <div class="flex h-8 shrink-0 items-center justify-between border-b border-border-2 px-4 eyebrow">
        <span>outcome</span>
        <div class="segmented">
          <button
            data-active={outcomeIdx() === 0}
            onClick={() => {
              userTypedPrice = false
              setOutcomeIdx(0)
            }}
          >
            {props.market.outcomes[0] ?? 'Yes'}
          </button>
          <Show when={noToken()}>
            <button
              data-active={outcomeIdx() === 1}
              onClick={() => {
                userTypedPrice = false
                setOutcomeIdx(1)
              }}
            >
              {props.market.outcomes[1] ?? 'No'}
            </button>
          </Show>
        </div>
      </div>

      {/* Side */}
      <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border-2 px-4">
        <button
          data-active={side() === 'BUY'}
          onClick={() => {
            userTypedPrice = false
            setSide('BUY')
          }}
          class={
            'h-7 flex-1 cursor-pointer border text-[11px] font-semibold uppercase tracking-[0.14em] ' +
            (side() === 'BUY'
              ? 'border-up bg-up/15 text-up'
              : 'border-border-2 text-text-dim hover:text-text-bright')
          }
        >
          Buy
        </button>
        <button
          data-active={side() === 'SELL'}
          onClick={() => {
            userTypedPrice = false
            setSide('SELL')
          }}
          class={
            'h-7 flex-1 cursor-pointer border text-[11px] font-semibold uppercase tracking-[0.14em] ' +
            (side() === 'SELL'
              ? 'border-down bg-down/15 text-down'
              : 'border-border-2 text-text-dim hover:text-text-bright')
          }
        >
          Sell
        </button>
      </div>

      {/* Amount */}
      <div class="border-b border-border-2 px-4 py-3">
        <div class="flex items-end justify-between eyebrow">
          <span>{amountLabel()}</span>
          <Show
            when={kind() === 'limit' && Number.isFinite(priceDec()) && amount() > 0}
          >
            <span class="tabular-nums text-text normal-case tracking-normal">
              cost ${(amount() * priceDec()).toFixed(2)}
            </span>
          </Show>
        </div>
        <div class="mt-1 flex items-center gap-2">
          <Show when={amountUnit()}>
            <span class="text-[20px] text-text-dim">{amountUnit()}</span>
          </Show>
          <input
            type="number"
            inputmode="decimal"
            step="any"
            min="0"
            placeholder="0"
            value={amountStr()}
            onInput={(e) => setAmountStr(e.currentTarget.value)}
            class="flex-1 bg-transparent tabular-nums text-[20px] font-semibold text-text-bright outline-none placeholder:text-text-dimmer"
          />
        </div>
        <div class="mt-2 flex gap-1.5">
          <For each={presets()}>
            {(p) => (
              <button
                onClick={() => setAmountStr(String(p))}
                class="flex-1 border border-border-2 bg-transparent py-1 text-[10px] tabular-nums text-text-dim hover:border-border-3 hover:text-text-bright"
              >
                {kind() === 'market' && side() === 'BUY' ? `$${p}` : p}
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Price (limit only) */}
      <Show when={kind() === 'limit'}>
        <div class="border-b border-border-2 px-4 py-3">
          <div class="flex items-end justify-between eyebrow">
            <span>price (¢)</span>
            <Show when={bestBid() != null && bestAsk() != null}>
              <span class="tabular-nums text-text-dim normal-case tracking-normal">
                bid {(bestBid()! * 100).toFixed(2)}¢ · ask{' '}
                {(bestAsk()! * 100).toFixed(2)}¢
              </span>
            </Show>
          </div>
          <input
            type="number"
            inputmode="decimal"
            step={String(tickSize() * 100)}
            min="0"
            max="100"
            placeholder="50.00"
            value={priceStr()}
            onInput={(e) => {
              userTypedPrice = true
              setPriceStr(e.currentTarget.value)
            }}
            class="mt-1 w-full bg-transparent tabular-nums text-[20px] font-semibold text-text-bright outline-none placeholder:text-text-dimmer"
          />
          <label class="mt-2 flex cursor-pointer items-center gap-2 eyebrow">
            <input
              type="checkbox"
              checked={postOnly()}
              onChange={(e) => setPostOnly(e.currentTarget.checked)}
            />
            <span>post-only (maker-only, no crossing)</span>
          </label>
        </div>
      </Show>

      {/* Market preview (market only) */}
      <Show when={kind() === 'market' && marketPreview()}>
        {(_mp) => {
          const mp = marketPreview()!
          return (
            <div class="border-b border-border-2 px-4 py-2.5 eyebrow">
              <div class="flex items-center justify-between">
                <span>est. fill</span>
                <span class="tabular-nums text-text-bright normal-case tracking-normal">
                  {side() === 'BUY'
                    ? `${fmtNum(mp.fillable)} shares`
                    : `$${mp.fillable.toFixed(2)}`}{' '}
                  @ {(mp.avgPrice * 100).toFixed(2)}¢ avg
                </span>
              </div>
              <div class="mt-1 flex items-center justify-between text-text-dim normal-case tracking-normal">
                <span>slippage cap</span>
                <span class="tabular-nums">
                  {MARKET_SLIPPAGE * 100}% · worst{' '}
                  {marketWorstPrice() != null
                    ? `${(marketWorstPrice()! * 100).toFixed(2)}¢`
                    : '—'}
                </span>
              </div>
              <Show when={mp.partial}>
                <div class="mt-1 text-down normal-case tracking-normal">
                  partial fill — reduce size or switch to limit
                </div>
              </Show>
            </div>
          )
        }}
      </Show>

      {/* Submit */}
      <div class="shrink-0 border-b border-border-2 px-4 py-3">
        <button
          onClick={submit}
          disabled={placeMut.isPending || needsInit()}
          class={
            'h-11 w-full cursor-pointer border text-[12px] font-semibold uppercase tracking-[0.14em] disabled:opacity-60 ' +
            (side() === 'BUY'
              ? 'border-up bg-up/15 text-up hover:bg-up/25'
              : 'border-down bg-down/15 text-down hover:bg-down/25')
          }
        >
          {placeMut.isPending ? 'signing…' : submitLabel()}
        </button>
        <Show when={submitError()}>
          <div class="mt-2 text-[10px] text-down">{submitError()}</div>
        </Show>
        <Show when={lastOk()}>
          <div class="mt-2 text-[10px] text-up">{lastOk()}</div>
        </Show>
      </div>

      {/* Open orders */}
      <div class="flex min-h-0 flex-col">
        <div class="flex h-7 shrink-0 items-center justify-between border-b border-border px-4 eyebrow">
          <span>open orders</span>
          <span class="tabular-nums">{openOrdersQuery.data?.length ?? 0}</span>
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
                const oid = (): string => o.id ?? o.order_id ?? o.orderId ?? ''
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

function shortHash(h: string) {
  if (!h) return ''
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h
}
