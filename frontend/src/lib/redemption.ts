/**
 * Position redemption — turning winning conditional-token shares into USDC.
 *
 * For non-neg-risk binary markets, the canonical ConditionalTokens
 * (CTF) contract exposes `redeemPositions(collateral, parentCollectionId,
 * conditionId, indexSets)`. Calling with `indexSets = [1, 2]` redeems both
 * outcomes in one shot — the contract pays out 1 USDC per share you hold
 * on the resolved side, 0 on the losing side, and burns both balances.
 *
 * EOA mode: send the tx directly from the user's wallet — they own the CTF
 * balances on their EOA.
 *
 * Safe mode: the Safe owns the CTF balances. Wrap the redeem call in a
 * Safe `execTransaction` with a pre-validated signature (the same scheme
 * used by `safeSetup.setupApprovals`, but with a single inner call so no
 * MultiSend needed).
 *
 * Neg-risk multi-outcome markets are NOT supported here — they redeem
 * through `NegRiskAdapter.redeemPositions(conditionId, amounts)`, which has
 * a different shape and outcome-count semantics. Callers should gate on
 * `market.negRisk` and surface a "redeem on polymarket.com" message instead.
 */

import {
  concat,
  encodeFunctionData,
  pad,
  zeroAddress,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem'
import { polygon } from 'viem/chains'
import {
  CTF_ADDRESS,
  NEG_RISK_ADAPTER,
  USDC_ADDRESS,
  getPublicClient,
} from './wallet'

const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const

const ctfRedeemAbi = [
  {
    type: 'function',
    name: 'redeemPositions',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    outputs: [],
  },
] as const

// NegRiskAdapter.redeemPositions(bytes32, uint256[2]) — verified against
// https://github.com/Polymarket/neg-risk-ctf-adapter (src/NegRiskAdapter.sol).
// amounts MUST be length 2: [yesShares, noShares] in raw 6-decimal units.
// The amounts are pulled from the caller via safeBatchTransferFrom before
// payout, so the caller must hold the CTF balances and have set CTF
// approval for this adapter as operator (already done by setupApprovals).
const negRiskRedeemAbi = [
  {
    type: 'function',
    name: 'redeemPositions',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_conditionId', type: 'bytes32' },
      { name: '_amounts', type: 'uint256[]' },
    ],
    outputs: [],
  },
] as const

const safeExecAbi = [
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const

function ensureBytes32(s: string): Hex {
  const v = s.startsWith('0x') ? s : `0x${s}`
  if (v.length !== 66) {
    throw new Error(`expected bytes32 hex (got length ${v.length})`)
  }
  return v as Hex
}

/**
 * Pre-validated Gnosis Safe signature (type 0x01): 65 bytes of
 *   padLeft(owner, 32) + bytes32(0) + 0x01
 * Accepted by Safe.execTransaction when `msg.sender == owner`. Same scheme
 * as safeSetup.ts; duplicated locally to avoid a circular import.
 */
function preValidatedSig(owner: Address): Hex {
  return concat([
    pad(owner, { size: 32 }),
    pad('0x', { size: 32 }),
    '0x01',
  ]) as Hex
}

function redeemCalldata(conditionId: string): Hex {
  return encodeFunctionData({
    abi: ctfRedeemAbi,
    functionName: 'redeemPositions',
    args: [USDC_ADDRESS, ZERO_BYTES32, ensureBytes32(conditionId), [1n, 2n]],
  })
}

function negRiskRedeemCalldata(
  conditionId: string,
  yesRaw: bigint,
  noRaw: bigint
): Hex {
  return encodeFunctionData({
    abi: negRiskRedeemAbi,
    functionName: 'redeemPositions',
    args: [ensureBytes32(conditionId), [yesRaw, noRaw]],
  })
}

/** Convert human-readable share count (e.g. 10.5) to raw 6-decimal units. */
export const sharesToRaw = (n: number): bigint =>
  BigInt(Math.max(0, Math.floor(n * 1_000_000)))

/**
 * EOA-mode redemption — caller signs and submits directly. The EOA must
 * hold the CTF balances (i.e. user trades in EOA mode).
 */
export async function redeemBinaryFromEOA(
  walletClient: WalletClient,
  eoa: Address,
  conditionId: string
): Promise<Hex> {
  return walletClient.sendTransaction({
    account: eoa,
    chain: polygon,
    to: CTF_ADDRESS,
    data: redeemCalldata(conditionId),
  })
}

/**
 * Safe-mode redemption — wraps the CTF call in Safe.execTransaction with a
 * pre-validated signature. Submitted from the EOA (== Safe owner), so
 * msg.sender == owner and no ECDSA signature is required.
 */
export async function redeemBinaryFromSafe(
  walletClient: WalletClient,
  eoa: Address,
  safe: Address,
  conditionId: string
): Promise<Hex> {
  const execCall = encodeFunctionData({
    abi: safeExecAbi,
    functionName: 'execTransaction',
    args: [
      CTF_ADDRESS,
      0n,
      redeemCalldata(conditionId),
      0, // operation = CALL
      0n,
      0n,
      0n,
      zeroAddress,
      zeroAddress,
      preValidatedSig(eoa),
    ],
  })
  return walletClient.sendTransaction({
    account: eoa,
    chain: polygon,
    to: safe,
    data: execCall,
  })
}

/** Neg-risk redemption — EOA mode. amounts come from the user's positions. */
export async function redeemNegRiskFromEOA(
  walletClient: WalletClient,
  eoa: Address,
  conditionId: string,
  yesShares: number,
  noShares: number
): Promise<Hex> {
  return walletClient.sendTransaction({
    account: eoa,
    chain: polygon,
    to: NEG_RISK_ADAPTER,
    data: negRiskRedeemCalldata(
      conditionId,
      sharesToRaw(yesShares),
      sharesToRaw(noShares)
    ),
  })
}

/** Neg-risk redemption — Safe mode (Safe holds the CTF balances). */
export async function redeemNegRiskFromSafe(
  walletClient: WalletClient,
  eoa: Address,
  safe: Address,
  conditionId: string,
  yesShares: number,
  noShares: number
): Promise<Hex> {
  const inner = negRiskRedeemCalldata(
    conditionId,
    sharesToRaw(yesShares),
    sharesToRaw(noShares)
  )
  const execCall = encodeFunctionData({
    abi: safeExecAbi,
    functionName: 'execTransaction',
    args: [
      NEG_RISK_ADAPTER,
      0n,
      inner,
      0,
      0n,
      0n,
      0n,
      zeroAddress,
      zeroAddress,
      preValidatedSig(eoa),
    ],
  })
  return walletClient.sendTransaction({
    account: eoa,
    chain: polygon,
    to: safe,
    data: execCall,
  })
}

export async function waitRedemptionTx(hash: Hex): Promise<void> {
  const receipt = await getPublicClient().waitForTransactionReceipt({
    hash,
    timeout: 120_000,
  })
  if (receipt.status !== 'success') {
    throw new Error(`redemption tx ${hash} reverted`)
  }
}
