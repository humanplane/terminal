import { createSignal, onMount } from 'solid-js'
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
  getAddress,
  getCreate2Address,
  http,
  keccak256,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { polygon } from 'viem/chains'

const LS_EOA_KEY = 'humanplane:wallet:eoa:v1'

/** ----- Polymarket contract constants (Polygon mainnet) --------------- */

/**
 * Safe factory Polymarket uses for browser-wallet (MetaMask/Coinbase/etc)
 * users. Each EOA gets a deterministic 1-of-1 Safe derived via CREATE2.
 * Non-Safe (Magic / email) users go through a different factory; we only
 * target browser wallets here.
 */
export const SAFE_FACTORY: Address = getAddress(
  '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b'
)
export const SAFE_INIT_CODE_HASH =
  '0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf' as `0x${string}`

/** USDC.e (bridged) on Polygon — Polymarket's quote currency. */
export const USDC_ADDRESS: Address = getAddress(
  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
)
/** CTF ERC1155 conditional-token contract. */
export const CTF_ADDRESS: Address = getAddress(
  '0x4D97DCd97eC945f40cf65F87097ACE5EA0476045'
)
/** Standard CTF exchange (non-neg-risk markets). */
export const CTF_EXCHANGE: Address = getAddress(
  '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'
)
/** Neg-risk CTF exchange (multi-outcome markets). */
export const NEG_RISK_CTF_EXCHANGE: Address = getAddress(
  '0xC5d563A36AE78145C45a50134d48A1215220f80a'
)
/** Neg-risk USDC adapter — additional approval target for neg-risk markets. */
export const NEG_RISK_ADAPTER: Address = getAddress(
  '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'
)

/** Polymarket signature types (as defined by their CLOB client). */
export const SIGNATURE_TYPE_EOA = 0 as const
export const SIGNATURE_TYPE_SAFE = 2 as const

/**
 * Trading mode: where the user's USDC lives and who signs orders.
 *   - 'eoa': signer == funder == EOA. Direct trading. Single USDC.approve
 *           from the EOA; no Safe involved.
 *   - 'safe': signer == EOA, funder == derived Polymarket Safe. Required if
 *           you onboarded via polymarket.com (they deposit USDC to the Safe).
 */
export type TradingMode = 'eoa' | 'safe'
const LS_MODE_KEY = 'humanplane:wallet:mode:v1'

/**
 * Canonical Gnosis Safe MultiSendCallOnly v1.3.0 on Polygon.
 * The outer Safe.execTransaction must DELEGATECALL into this to atomically
 * batch multiple inner calls (approvals etc.) from the Safe's own context.
 */
export const MULTI_SEND_CALL_ONLY: Address = getAddress(
  '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D'
)

/** ----- State --------------------------------------------------------- */

type WalletState = {
  eoa: Address | null
  /** Polymarket Safe (proxy) address — what `/api/user/:addr/*` expects. */
  safe: Address | null
  chainId: number | null
  mode: TradingMode
  connecting: boolean
  error: string | null
}

function loadInitialMode(): TradingMode {
  try {
    const m = localStorage.getItem(LS_MODE_KEY)
    return m === 'safe' ? 'safe' : 'eoa'
  } catch {
    return 'eoa'
  }
}

const [state, setState] = createSignal<WalletState>({
  eoa: null,
  safe: null,
  chainId: null,
  mode: loadInitialMode(),
  connecting: false,
  error: null,
})

export const wallet = {
  state,
  eoa: () => state().eoa,
  safe: () => state().safe,
  mode: () => state().mode,
  /**
   * The "funder" for Polymarket: where the USDC lives.
   * EOA mode → EOA, Safe mode → derived Safe.
   */
  funder: (): Address | null =>
    state().mode === 'eoa' ? state().eoa : state().safe,
  isConnected: () => state().eoa != null,
  onPolygon: () => state().chainId === polygon.id,
  isConnecting: () => state().connecting,
  error: () => state().error,
}

export function setTradingMode(mode: TradingMode) {
  try {
    localStorage.setItem(LS_MODE_KEY, mode)
  } catch {
    /* noop */
  }
  // Invalidate any cached ClobClient — funder + signatureType change.
  import('./polymarket').then((m) => m.invalidateClobClient())
  setState((s) => ({ ...s, mode }))
}

/** ----- Address derivation -------------------------------------------- */

/**
 * Deterministically derive the Polymarket Safe address for a browser-wallet
 * EOA. Uses CREATE2 with the Safe factory; same EOA → same Safe forever.
 */
export function deriveSafeAddress(eoa: Address): Address {
  const salt = keccak256(
    encodeAbiParameters([{ name: 'owner', type: 'address' }], [eoa])
  )
  return getCreate2Address({
    from: SAFE_FACTORY,
    salt,
    bytecodeHash: SAFE_INIT_CODE_HASH,
  })
}

/** ----- Connect / disconnect ------------------------------------------ */

export async function connect(): Promise<void> {
  if (state().connecting) return
  setState((s) => ({ ...s, connecting: true, error: null }))
  try {
    const provider = (window as any).ethereum
    if (!provider) {
      throw new Error('No Ethereum wallet detected — install MetaMask')
    }
    const accounts: string[] = await provider.request({
      method: 'eth_requestAccounts',
    })
    if (!accounts.length) throw new Error('User rejected connection')
    const eoa = getAddress(accounts[0])

    // Ensure Polygon.
    let chainIdHex: string = await provider.request({ method: 'eth_chainId' })
    let chainId = parseInt(chainIdHex, 16)
    if (chainId !== polygon.id) {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${polygon.id.toString(16)}` }],
      })
      chainIdHex = await provider.request({ method: 'eth_chainId' })
      chainId = parseInt(chainIdHex, 16)
    }

    const safe = deriveSafeAddress(eoa)
    localStorage.setItem(LS_EOA_KEY, eoa)
    setState((s) => ({
      ...s,
      eoa,
      safe,
      chainId,
      connecting: false,
      error: null,
    }))

    provider.removeListener?.('accountsChanged', onAccountsChanged)
    provider.removeListener?.('chainChanged', onChainChanged)
    provider.on?.('accountsChanged', onAccountsChanged)
    provider.on?.('chainChanged', onChainChanged)
  } catch (e) {
    setState((s) => ({
      ...s,
      connecting: false,
      error: e instanceof Error ? e.message : String(e),
    }))
  }
}

function onAccountsChanged(accounts: string[]) {
  // Clear cached Polymarket credentials for the previous EOA — creds are
  // keyed by (eoa, funder, sigType), so we nuke all of them for that EOA.
  // Also drop the cached ClobClient so the next call rebuilds.
  const prevEoa = state().eoa
  import('./polymarket').then((m) => {
    if (prevEoa) m.clearCreds(prevEoa)
    m.invalidateClobClient()
  })

  if (!accounts.length) {
    disconnect()
    return
  }
  const eoa = getAddress(accounts[0])
  localStorage.setItem(LS_EOA_KEY, eoa)
  setState((s) => ({
    ...s,
    eoa,
    safe: deriveSafeAddress(eoa),
    error: null,
  }))
}

function onChainChanged(hex: string) {
  setState((s) => ({ ...s, chainId: parseInt(hex, 16) }))
}

export function disconnect() {
  const prevEoa = state().eoa
  import('./polymarket').then((m) => {
    if (prevEoa) m.clearCreds(prevEoa)
    m.invalidateClobClient()
  })
  localStorage.removeItem(LS_EOA_KEY)
  setState((s) => ({
    ...s,
    eoa: null,
    safe: null,
    chainId: null,
    connecting: false,
    error: null,
  }))
}

/** Silent auto-reconnect on app boot if wallet was previously authorized. */
export function initWalletAutoReconnect() {
  onMount(async () => {
    const provider = (window as any).ethereum
    if (!provider) return
    const prev = localStorage.getItem(LS_EOA_KEY)
    if (!prev) return
    try {
      const accounts: string[] = await provider.request({
        method: 'eth_accounts',
      })
      if (!accounts.length) return
      const eoa = getAddress(accounts[0])
      if (eoa.toLowerCase() !== prev.toLowerCase()) return
      const chainIdHex = await provider.request({ method: 'eth_chainId' })
      setState((s) => ({
        ...s,
        eoa,
        safe: deriveSafeAddress(eoa),
        chainId: parseInt(chainIdHex, 16),
        connecting: false,
        error: null,
      }))
      provider.on?.('accountsChanged', onAccountsChanged)
      provider.on?.('chainChanged', onChainChanged)
    } catch {
      /* silent */
    }
  })
}

/** ----- viem clients -------------------------------------------------- */

export function getWalletClient(): WalletClient | null {
  const eoa = state().eoa
  const provider = (window as any).ethereum
  if (!eoa || !provider) return null
  return createWalletClient({
    account: eoa,
    chain: polygon,
    transport: custom(provider),
  })
}

let _publicClient: PublicClient | null = null
export function getPublicClient(): PublicClient {
  if (!_publicClient) {
    // Prefer an explicit RPC from env (Alchemy / QuickNode / etc.) — viem's
    // default is the public Polygon RPC which rate-limits aggressively.
    const envRpc = import.meta.env.VITE_POLYGON_RPC_URL as string | undefined
    _publicClient = createPublicClient({
      chain: polygon,
      transport: http(envRpc || undefined),
    })
  }
  return _publicClient
}

export function shortAddr(a?: string | null): string {
  if (!a) return ''
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
