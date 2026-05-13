import { Show, createSignal } from 'solid-js'
import { createMutation, useQueryClient } from '@tanstack/solid-query'
import type { Market, UserPosition } from '../lib/api'
import { getWalletClient, wallet } from '../lib/wallet'
import {
  redeemBinaryFromEOA,
  redeemBinaryFromSafe,
  redeemNegRiskFromEOA,
  redeemNegRiskFromSafe,
  waitRedemptionTx,
} from '../lib/redemption'
import { showToast } from '../lib/toast'
import { fmtNum } from '../lib/format'

type Props = {
  market: Market
  /** All user positions for this market (filtered by caller). May be []. */
  positions: UserPosition[]
}

/**
 * Banner shown above the chart when:
 *  - the market is closed, AND
 *  - the connected user holds at least one unredeemed CTF balance on it.
 *
 * Neg-risk markets fall through to a polymarket.com pointer for now (the
 * adapter has a different redemption ABI; tracked as P5c).
 */
export function RedemptionBanner(props: Props) {
  const qc = useQueryClient()
  const [success, setSuccess] = createSignal<string | null>(null)

  const totalShares = () =>
    props.positions.reduce((n, p) => n + (p.size || 0), 0)

  // Best-effort payout estimate from the data API's curPrice (1 for winning
  // outcome, 0 for losing, after resolution). Reality is whatever the CTF
  // computes — show it as "≈" to signal estimate.
  const estPayout = () =>
    props.positions.reduce((n, p) => n + (p.size || 0) * (p.curPrice || 0), 0)

  // Sum shares by outcome for neg-risk redemption (length-2 amounts array).
  const yesShares = () =>
    props.positions
      .filter((p) => p.outcomeIndex === 0)
      .reduce((n, p) => n + (p.size || 0), 0)
  const noShares = () =>
    props.positions
      .filter((p) => p.outcomeIndex === 1)
      .reduce((n, p) => n + (p.size || 0), 0)

  const redeemMut = createMutation(() => ({
    mutationFn: async () => {
      const wc = getWalletClient()
      if (!wc) throw new Error('wallet not available')
      const eoa = wallet.eoa()
      if (!eoa) throw new Error('wallet not connected')
      const mode = wallet.mode()
      const cid = props.market.conditionId
      let hash
      if (props.market.negRisk) {
        hash =
          mode === 'safe'
            ? await redeemNegRiskFromSafe(
                wc,
                eoa,
                wallet.safe()!,
                cid,
                yesShares(),
                noShares()
              )
            : await redeemNegRiskFromEOA(wc, eoa, cid, yesShares(), noShares())
      } else {
        hash =
          mode === 'safe'
            ? await redeemBinaryFromSafe(wc, eoa, wallet.safe()!, cid)
            : await redeemBinaryFromEOA(wc, eoa, cid)
      }
      await waitRedemptionTx(hash)
      return hash
    },
    onSuccess: (hash) => {
      setSuccess(hash)
      showToast({
        kind: 'info',
        message: `Redeemed · ${hash.slice(0, 10)}…`,
      })
      qc.invalidateQueries({ queryKey: ['user-positions'] })
      qc.invalidateQueries({ queryKey: ['usdc-status'] })
    },
  }))

  return (
    <div class="border-b border-border-3 bg-panel-2 px-4 py-2.5">
      <div class="flex items-center justify-between gap-3">
        <div class="text-[11px] leading-snug">
          <div class="eyebrow-bright">
            market resolved · claim winnings
            <Show when={props.market.negRisk}>
              <span class="ml-2 text-text-dim normal-case tracking-normal">
                (neg-risk)
              </span>
            </Show>
          </div>
          <div class="mt-1 text-text-dim">
            <span class="tabular-nums text-text">
              {fmtNum(totalShares())} shares
            </span>
            {' · '}
            <span class="tabular-nums">≈ ${estPayout().toFixed(2)}</span>
            {' '}USDC
          </div>
        </div>
        <button
          onClick={() => redeemMut.mutate()}
          disabled={redeemMut.isPending || !!success()}
          class="h-8 cursor-pointer border border-text-bright bg-text-bright px-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-bg hover:bg-text hover:border-text disabled:opacity-60"
        >
          {redeemMut.isPending
            ? 'redeeming…'
            : success()
              ? 'redeemed'
              : 'claim'}
        </button>
      </div>
      <Show when={redeemMut.error}>
        <div class="mt-2 text-[10px] text-down">
          {(redeemMut.error as Error).message}
        </div>
      </Show>
    </div>
  )
}
