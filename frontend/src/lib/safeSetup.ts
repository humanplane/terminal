/**
 * Safe deployment + Polymarket approvals, run directly from the user's EOA
 * (no builder-relayer needed). Costs ~0.2–0.3 MATIC in gas total.
 *
 * Flow:
 *   1. `deploySafe(eoa)` — user signs EIP-712 `CreateProxy`, we submit the
 *      factory tx. Gas ~260k.
 *   2. `setupApprovals(eoa, safe)` — build a MultiSend batching the 7
 *      approvals, wrap in a Safe.execTransaction with a pre-validated sig,
 *      submit from the EOA. Gas ~450–500k.
 *
 * Why no separate EIP-712 sig on step 2: 1-of-1 Gnosis Safes accept the
 * pre-validated signature scheme (sig type 0x01) when `msg.sender == owner`.
 * The EOA IS the owner and IS submitting the tx, so no ECDSA sig is needed.
 */

import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  hexToNumber,
  maxUint256,
  numberToHex,
  pad,
  parseSignature,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem'
import { polygon } from 'viem/chains'
import {
  CTF_ADDRESS,
  CTF_EXCHANGE,
  MULTI_SEND_CALL_ONLY,
  NEG_RISK_ADAPTER,
  NEG_RISK_CTF_EXCHANGE,
  SAFE_FACTORY,
  USDC_ADDRESS,
  getPublicClient,
} from './wallet'

// ---- ABIs ------------------------------------------------------------------

/**
 * CRITICAL: the on-chain Sig struct is ordered (v, r, s) — NOT (r, s, v).
 * Verified against Polymarket/proxy-factories/packages/safe-factory source.
 * Canonical selector for the corrected signature is 0x1688f0b9. Getting this
 * order wrong makes ecrecover return garbage → the Safe is initialized with
 * the wrong owner and funds are effectively unrecoverable.
 */
const factoryAbi = [
  {
    type: 'function',
    name: 'createProxy',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
      {
        name: 'createSig',
        type: 'tuple',
        components: [
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'computeProxyAddress',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
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

const multiSendAbi = [
  {
    type: 'function',
    name: 'multiSend',
    stateMutability: 'payable',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
  },
] as const

const erc1155ApprovalAbi = [
  {
    type: 'function',
    name: 'setApprovalForAll',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
  },
] as const

// ---- Gas estimation --------------------------------------------------------

/**
 * ~0.3 MATIC is a comfortable headroom for both init txs at current Polygon
 * gas prices. Below this, we warn the user to top up before proceeding.
 */
export const MIN_MATIC_WEI = 300_000_000_000_000_000n // 0.3 MATIC

// ---- CreateProxy EIP-712 ---------------------------------------------------

const CREATE_PROXY_DOMAIN = {
  name: 'Polymarket Contract Proxy Factory',
  chainId: polygon.id,
  verifyingContract: SAFE_FACTORY,
} as const

const CREATE_PROXY_TYPES = {
  CreateProxy: [
    { name: 'paymentToken', type: 'address' },
    { name: 'payment', type: 'uint256' },
    { name: 'paymentReceiver', type: 'address' },
  ],
} as const

/**
 * Sign the `CreateProxy` EIP-712 message with the user's EOA. The factory
 * uses `ecrecover` over this to derive the Safe owner — so whoever signs
 * becomes the Safe's owner. We pass through a free deploy (payment=0).
 */
async function signCreateProxy(
  walletClient: WalletClient,
  eoa: Address
): Promise<{ v: number; r: Hex; s: Hex }> {
  const rawSig = await walletClient.signTypedData({
    account: eoa,
    domain: CREATE_PROXY_DOMAIN,
    types: CREATE_PROXY_TYPES,
    primaryType: 'CreateProxy',
    message: {
      paymentToken: zeroAddress,
      payment: 0n,
      paymentReceiver: zeroAddress,
    },
  })
  const split = parseSignature(rawSig)
  return {
    v: Number(split.v ?? (split.yParity === 0 ? 27 : 28)),
    r: split.r,
    s: split.s,
  }
}

// ---- Safe pre-validated signature -----------------------------------------

/**
 * Pre-validated sig (Gnosis Safe type 0x01): 65 bytes of
 *   padLeft(owner, 32) + bytes32(0) + 0x01
 * Accepted by Safe.execTransaction when `msg.sender == owner`.
 */
function preValidatedSig(owner: Address): Hex {
  return concat([
    pad(owner, { size: 32 }),
    pad('0x', { size: 32 }),
    '0x01',
  ]) as Hex
}

// ---- MultiSend calldata packing -------------------------------------------

type InnerCall = {
  to: Address
  value?: bigint
  data: Hex
  operation?: 0 | 1 // 0 = CALL (default), 1 = DELEGATECALL
}

/**
 * Pack a list of inner calls into the bytes payload multiSend() expects.
 * Each entry: operation(1) | to(20) | value(32) | dataLen(32) | data
 */
function packMultiSend(calls: InnerCall[]): Hex {
  const parts = calls.map((c) => {
    const dataLen = (c.data.length - 2) / 2
    return concat([
      toHex(c.operation ?? 0, { size: 1 }),
      c.to,
      pad(numberToHex(c.value ?? 0n), { size: 32 }),
      pad(numberToHex(BigInt(dataLen)), { size: 32 }),
      c.data,
    ])
  })
  return concat(parts) as Hex
}

// ---- 7 approval calls ------------------------------------------------------

function buildApprovalCalls(): InnerCall[] {
  const approveUSDC = (spender: Address) =>
    ({
      to: USDC_ADDRESS,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, maxUint256],
      }),
    }) satisfies InnerCall

  const setApprovalForAllCTF = (operator: Address) =>
    ({
      to: CTF_ADDRESS,
      data: encodeFunctionData({
        abi: erc1155ApprovalAbi,
        functionName: 'setApprovalForAll',
        args: [operator, true],
      }),
    }) satisfies InnerCall

  return [
    approveUSDC(CTF_ADDRESS),
    approveUSDC(CTF_EXCHANGE),
    approveUSDC(NEG_RISK_CTF_EXCHANGE),
    approveUSDC(NEG_RISK_ADAPTER),
    setApprovalForAllCTF(CTF_EXCHANGE),
    setApprovalForAllCTF(NEG_RISK_CTF_EXCHANGE),
    setApprovalForAllCTF(NEG_RISK_ADAPTER),
  ]
}

// ---- Public API ------------------------------------------------------------

export type SetupStep =
  | { kind: 'deploy'; hash: Hex }
  | { kind: 'approvals'; hash: Hex }

/** Deploy the user's Polymarket Safe. Returns the tx hash. */
export async function deploySafe(
  walletClient: WalletClient,
  eoa: Address
): Promise<Hex> {
  const sig = await signCreateProxy(walletClient, eoa)
  const data = encodeFunctionData({
    abi: factoryAbi,
    functionName: 'createProxy',
    args: [zeroAddress, 0n, zeroAddress, sig],
  })
  return walletClient.sendTransaction({
    account: eoa,
    chain: polygon,
    to: SAFE_FACTORY,
    data,
  })
}

/**
 * Batch all 7 Polymarket approvals through the Safe in one tx.
 * Uses pre-validated sig — no EIP-712 signature required.
 */
export async function setupApprovals(
  walletClient: WalletClient,
  eoa: Address,
  safe: Address
): Promise<Hex> {
  const multiSendData = packMultiSend(buildApprovalCalls())
  const multiSendCall = encodeFunctionData({
    abi: multiSendAbi,
    functionName: 'multiSend',
    args: [multiSendData],
  })

  const execCall = encodeFunctionData({
    abi: safeExecAbi,
    functionName: 'execTransaction',
    args: [
      MULTI_SEND_CALL_ONLY,
      0n,
      multiSendCall,
      1, // operation = DELEGATECALL (required for MultiSend)
      0n, // safeTxGas
      0n, // baseGas
      0n, // gasPrice
      zeroAddress, // gasToken
      zeroAddress, // refundReceiver
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

/** Wait for a tx to be mined and confirm it succeeded. */
export async function waitForTx(hash: Hex): Promise<void> {
  const receipt = await getPublicClient().waitForTransactionReceipt({
    hash,
    timeout: 120_000,
  })
  if (receipt.status !== 'success') {
    throw new Error(`tx ${hash} reverted`)
  }
}

/** Current MATIC balance on the EOA in wei. */
export async function fetchMaticBalance(eoa: Address): Promise<bigint> {
  return getPublicClient().getBalance({ address: eoa })
}

// Re-exports used by consumers — silence unused import warnings.
void encodeAbiParameters
void encodePacked
void hexToNumber
