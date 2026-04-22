import { ClobClient, OrderType, Side } from '@polymarket/clob-client'
import {
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem'
import { polygon } from 'viem/chains'
import {
  CTF_ADDRESS,
  CTF_EXCHANGE,
  NEG_RISK_ADAPTER,
  NEG_RISK_CTF_EXCHANGE,
  SIGNATURE_TYPE_EOA,
  SIGNATURE_TYPE_SAFE,
  USDC_ADDRESS,
  getPublicClient,
  getWalletClient,
  wallet,
} from './wallet'

const CLOB_HOST = 'https://clob.polymarket.com'

const LS_CREDS_PREFIX = 'humanplane:polymarket:creds:v1:'

type Creds = { key: string; secret: string; passphrase: string }

/** ---- Credential persistence ----------------------------------------- */

/**
 * L2 credentials are scoped by (signer EOA, funder, signatureType) — the
 * CLOB issues distinct keys for the same EOA signing under different funder
 * or sigType combos. Keying only by EOA would cause cross-mode reuse that
 * the server rejects.
 */
function credsKey(
  eoa: string,
  funder: string,
  sigType: number
): string {
  return `${LS_CREDS_PREFIX}${eoa.toLowerCase()}:${funder.toLowerCase()}:${sigType}`
}

function loadCreds(
  eoa: string,
  funder: string,
  sigType: number
): Creds | null {
  try {
    const raw = localStorage.getItem(credsKey(eoa, funder, sigType))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.key && parsed?.secret && parsed?.passphrase) return parsed
    return null
  } catch {
    return null
  }
}

function saveCreds(
  eoa: string,
  funder: string,
  sigType: number,
  creds: Creds
) {
  try {
    localStorage.setItem(
      credsKey(eoa, funder, sigType),
      JSON.stringify(creds)
    )
  } catch {
    /* quota */
  }
}

/**
 * Clear all L2 credentials for a given EOA across every mode/funder combo.
 * Called on wallet disconnect or account-switch.
 */
export function clearCredsForEoa(eoa: string) {
  try {
    const prefix = `${LS_CREDS_PREFIX}${eoa.toLowerCase()}:`
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) toRemove.push(k)
    }
    for (const k of toRemove) localStorage.removeItem(k)
  } catch {
    /* noop */
  }
}

/**
 * Legacy name kept so existing callers (wallet.ts) don't break. Argument is
 * now the EOA (not the Safe) — see audit P0 #2.
 */
export const clearCreds = clearCredsForEoa

/** Returns true if we have L2 credentials cached locally for the current
 * wallet + trading mode. Safe to call from polling code. */
export function hasCachedCreds(): boolean {
  const eoa = wallet.eoa()
  const funder = wallet.funder()
  if (!eoa || !funder) return false
  const sigType = wallet.mode() === 'eoa' ? SIGNATURE_TYPE_EOA : SIGNATURE_TYPE_SAFE
  return loadCreds(eoa, funder, sigType) != null
}

/** ---- Ethers-compatible signer shim around viem ---------------------- */
/**
 * @polymarket/clob-client expects an ethers-style signer interface
 * (getAddress, signMessage, _signTypedData, provider.getNetwork). We wrap a
 * viem WalletClient to provide exactly that.
 */
function makeEthersSigner(
  walletClient: WalletClient,
  eoa: Address,
  reportedAddress?: Address
) {
  return {
    getAddress: async () => reportedAddress ?? eoa,
    signMessage: async (message: string | Uint8Array) => {
      const msg =
        typeof message === 'string'
          ? message
          : new TextDecoder().decode(message)
      return walletClient.signMessage({ account: eoa, message: msg })
    },
    _signTypedData: async (domain: any, types: any, value: any) => {
      const primaryType =
        (Object.keys(types).find((k) => k !== 'EIP712Domain') ??
          'Order') as string
      return walletClient.signTypedData({
        account: eoa,
        domain: {
          ...domain,
          chainId:
            domain?.chainId != null ? Number(domain.chainId) : undefined,
        },
        types,
        primaryType,
        message: value,
      })
    },
    provider: {
      getNetwork: async () => ({ chainId: 137 }),
    },
  }
}

/** ---- ClobClient factory --------------------------------------------- */
//
// Two caches:
//   * `_clientCache` — memoized authenticated ClobClient per (safe, key) so
//     repeated calls from the UI don't rebuild it (and don't accidentally
//     trigger duplicate create-or-derive key flows).
//   * `_derivingCreds` — an in-flight Promise map so parallel calls during a
//     cold start collapse into a single `createOrDeriveApiKey` round-trip.

const _clientCache = new Map<string, ClobClient>()
const _derivingCreds = new Map<string, Promise<Creds>>()

/** Clear the in-memory client cache — call when wallet or creds change. */
export function invalidateClobClient() {
  _clientCache.clear()
}

export async function getClobClient(): Promise<ClobClient | null> {
  const eoa = wallet.eoa()
  const funder = wallet.funder()
  if (!eoa || !funder) return null
  const wc = getWalletClient()
  if (!wc) return null

  const mode = wallet.mode()
  const sigType = mode === 'eoa' ? SIGNATURE_TYPE_EOA : SIGNATURE_TYPE_SAFE

  // L2 creds are scoped by (eoa, funder, sigType).
  let creds = loadCreds(eoa, funder, sigType)

  // NOTE: per the clob-client SDK source (order-builder/helpers.js):
  //   maker = funderAddress ?? eoaSignerAddress
  // The signer returns the EOA. The funder determines who holds USDC and
  // becomes the order maker:
  //   EOA mode  → funder = EOA  → maker = EOA
  //   Safe mode → funder = Safe → maker = Safe
  const signer = makeEthersSigner(wc, eoa, eoa) as any

  if (!creds) {
    // Dedupe concurrent derivations AND re-check the localStorage cache
    // just before claiming the slot — if another tab/caller finished
    // between our first read and now, we can skip the prompt.
    const slotKey = `${eoa.toLowerCase()}:${funder.toLowerCase()}:${sigType}`
    if (!_derivingCreds.has(slotKey)) {
      const refreshed = loadCreds(eoa, funder, sigType)
      if (refreshed) {
        creds = refreshed
      } else {
        const bootstrap = new ClobClient(
          CLOB_HOST,
          137,
          signer,
          undefined,
          sigType,
          funder,
          undefined, // geoBlockToken
          true
        )
        const p = bootstrap
          .createOrDeriveApiKey(0)
          .then((fresh) => {
            if (!fresh?.key) {
              throw new Error(
                'Polymarket returned empty credentials — check your wallet and try again'
              )
            }
            const c: Creds = {
              key: fresh.key,
              secret: fresh.secret,
              passphrase: fresh.passphrase,
            }
            saveCreds(eoa, funder, sigType, c)
            return c
          })
          .finally(() => {
            _derivingCreds.delete(slotKey)
          })
        _derivingCreds.set(slotKey, p)
        creds = await p
      }
    } else {
      creds = await _derivingCreds.get(slotKey)!
    }
  }

  const cacheKey = `${mode}:${funder.toLowerCase()}:${creds.key}`
  const cached = _clientCache.get(cacheKey)
  if (cached) return cached

  const client = new ClobClient(
    CLOB_HOST,
    137,
    signer,
    creds,
    sigType,
    funder,
    undefined, // geoBlockToken
    true
  )
  _clientCache.set(cacheKey, client)
  return client
}

/** ---- USDC balance + allowance --------------------------------------- */

export type AllowanceStatus = {
  balance: bigint
  ctfExchange: bigint
  negRiskExchange: bigint
  negRiskAdapter: bigint
}

/**
 * Read USDC balance + allowances for a holder (EOA or Safe — this function
 * doesn't care). Caller passes the address holding the funds for the current
 * trading mode.
 */
export async function fetchUsdcStatus(holder: Address): Promise<AllowanceStatus> {
  const pc = getPublicClient()
  const [balance, a1, a2, a3] = await Promise.all([
    pc.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [holder],
    }) as Promise<bigint>,
    pc.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [holder, CTF_EXCHANGE],
    }) as Promise<bigint>,
    pc.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [holder, NEG_RISK_CTF_EXCHANGE],
    }) as Promise<bigint>,
    pc.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [holder, NEG_RISK_ADAPTER],
    }) as Promise<bigint>,
  ])
  return {
    balance,
    ctfExchange: a1,
    negRiskExchange: a2,
    negRiskAdapter: a3,
  }
}

/**
 * EOA-mode approvals: sign `USDC.approve(spender, max)` directly from the
 * EOA. One tx per spender — batching would need a multicall contract which
 * isn't worth the complexity for a few approvals. User pays gas.
 */
export async function approveUsdcFromEOA(
  spender: Address,
  amount: bigint = maxUint256
): Promise<Hex> {
  const wc = getWalletClient()
  const eoa = wallet.eoa()
  if (!wc || !eoa) throw new Error('wallet not connected')
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  })
  return wc.sendTransaction({
    account: eoa,
    chain: polygon,
    to: USDC_ADDRESS,
    data,
  })
}

const ctfErc1155Abi = [
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
  {
    type: 'function',
    name: 'isApprovedForAll',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/**
 * EOA-mode CTF ERC-1155 approval. Required for SELL orders (the exchange
 * transfers conditional tokens out of your account). Without this, sells
 * revert with "ERC1155: caller is not token owner or approved".
 */
export async function setCtfApprovalForAllFromEOA(
  operator: Address,
  approved = true
): Promise<Hex> {
  const wc = getWalletClient()
  const eoa = wallet.eoa()
  if (!wc || !eoa) throw new Error('wallet not connected')
  const data = encodeFunctionData({
    abi: ctfErc1155Abi,
    functionName: 'setApprovalForAll',
    args: [operator, approved],
  })
  return wc.sendTransaction({
    account: eoa,
    chain: polygon,
    to: CTF_ADDRESS,
    data,
  })
}

/** Read CTF ERC-1155 operator approval for a given holder. */
export async function isCtfApprovedForAll(
  holder: Address,
  operator: Address
): Promise<boolean> {
  return (await getPublicClient().readContract({
    address: CTF_ADDRESS,
    abi: ctfErc1155Abi,
    functionName: 'isApprovedForAll',
    args: [holder, operator],
  })) as boolean
}

export const USDC_SPENDERS = {
  ctfExchange: CTF_EXCHANGE,
  negRiskExchange: NEG_RISK_CTF_EXCHANGE,
  negRiskAdapter: NEG_RISK_ADAPTER,
} as const

/**
 * Approve USDC for Polymarket exchange contracts.
 *
 * NOTE: For browser-wallet Safe users, approvals actually need to be executed
 * THROUGH the Safe (not from the EOA directly) — the EOA never holds USDC.
 * The relayer handles this. Full implementation is out of scope for this
 * MVP; we expose the function so you can at least detect the status and
 * direct the user to polymarket.com to run approvals there first.
 */
export const USDC_APPROVE_TARGETS = [
  CTF_EXCHANGE,
  NEG_RISK_CTF_EXCHANGE,
  NEG_RISK_ADAPTER,
] as const

/** ---- Order placement ------------------------------------------------ */

export type PlaceOrderArgs = {
  tokenId: string
  side: 'BUY' | 'SELL'
  price: number
  size: number
  tickSize?: number
  negRisk?: boolean
  orderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK'
  postOnly?: boolean
}

/** Friendlier error messages for common CLOB rejections. */
function translateOrderError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('invalid timestamp')) return 'Server clock skew — please retry'
  if (m.includes('not enough balance') || m.includes('allowance'))
    return 'Insufficient USDC balance or allowance'
  if (m.includes('lower than the minimum'))
    return `Size below this market's minimum: ${msg.replace(/\s*-\s*0x[0-9a-f]+/, '')}`
  if (m.includes('order crossed'))
    return 'Order crossed the book — try another price or drop post-only'
  if (m.includes('no orders found to match'))
    return 'No liquidity — nothing to match at this price'
  if (m.includes('invalid price'))
    return "Price isn't a multiple of this market's tick size"
  return msg
}

function throwIfResponseError(resp: any): void {
  const err = resp?.error || resp?.errorMsg
  const explicitFail = resp?.success === false
  if (err) throw new Error(translateOrderError(String(err)))
  if (explicitFail) throw new Error('Order failed')
}

/**
 * Prefer the tick size + neg-risk flags from the SDK itself (per-token) over
 * cached market metadata. Falls back silently on SDK errors.
 */
async function resolveMarketMeta(
  client: ClobClient,
  tokenId: string,
  fallback: { tickSize?: number; negRisk?: boolean }
): Promise<{ tickSize: string; negRisk: boolean }> {
  let tickSize: string
  let negRisk: boolean
  try {
    const raw = await client.getTickSize(tokenId)
    tickSize = String(raw)
  } catch {
    tickSize = String(fallback.tickSize ?? 0.01)
  }
  try {
    negRisk = await client.getNegRisk(tokenId)
  } catch {
    negRisk = fallback.negRisk ?? false
  }
  return { tickSize, negRisk }
}

export async function placeOrder(args: PlaceOrderArgs) {
  const client = await getClobClient()
  if (!client) throw new Error('wallet not connected')

  const side = args.side === 'BUY' ? Side.BUY : Side.SELL
  const type = args.orderType ?? 'GTC'

  // Pull fresh tick + neg-risk from the SDK; these drive exchange routing
  // and rounding. Passing the wrong values causes silent CLOB rejections.
  const meta = await resolveMarketMeta(client, args.tokenId, {
    tickSize: args.tickSize,
    negRisk: args.negRisk,
  })
  const options = { tickSize: meta.tickSize as any, negRisk: meta.negRisk }

  // Sync the CLOB's cached view of our Safe's on-chain allowance — prevents
  // "insufficient allowance" rejections after the user just approved.
  try {
    await client.updateBalanceAllowance({
      asset_type: 'COLLATERAL' as any,
    })
    if (side === Side.SELL) {
      await client.updateBalanceAllowance({
        asset_type: 'CONDITIONAL' as any,
        token_id: args.tokenId,
      })
    }
  } catch {
    /* best-effort */
  }

  let response: any
  if (type === 'FOK' || type === 'FAK') {
    // Market-order semantics: BUY → `amount` is USDC cost; SELL → shares.
    const amount = side === Side.BUY ? args.price * args.size : args.size
    const marketOrder = {
      tokenID: args.tokenId,
      price: args.price,
      amount,
      side,
    }
    response = await client.createAndPostMarketOrder(
      marketOrder as any,
      options,
      type === 'FOK' ? OrderType.FOK : OrderType.FAK
    )
  } else {
    const userOrder = {
      tokenID: args.tokenId,
      price: args.price,
      size: args.size,
      side,
    }
    response = await client.createAndPostOrder(
      userOrder,
      options,
      type === 'GTD' ? OrderType.GTD : OrderType.GTC,
      false,
      args.postOnly ?? false
    )
  }

  throwIfResponseError(response)
  return response
}

/**
 * List open orders — only if credentials are already cached. We never derive
 * creds from this code path because `openOrdersQuery` polls on an interval
 * and we don't want background polls triggering signature prompts.
 */
export async function listOpenOrders(params: { market?: string } = {}) {
  if (!hasCachedCreds()) return []
  const client = await getClobClient()
  if (!client) return []
  return client.getOpenOrders(params.market ? { market: params.market } : {})
}

export async function cancelOrder(orderID: string) {
  if (!orderID) throw new Error('missing order id')
  const client = await getClobClient()
  if (!client) throw new Error('wallet not connected')
  const resp = await client.cancelOrder({ orderID })
  throwIfResponseError(resp)
  return resp
}

/**
 * Check whether the user's Polymarket Safe has been deployed on-chain.
 * New Safes don't exist until the first deposit/approval tx is relayed —
 * trying to trade from an undeployed Safe will fail at the exchange level.
 */
export async function isSafeDeployed(safe: Address): Promise<boolean> {
  try {
    const code = await getPublicClient().getCode({ address: safe })
    return !!code && code !== '0x' && code.length > 2
  } catch {
    return false
  }
}
