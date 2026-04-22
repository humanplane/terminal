# humanplane

A **Polymarket prediction-market terminal**. Bloomberg-style dark UI, live order book via
SSE, click-through trader leaderboard, and in-browser order execution with no
third-party relayer.

> Markets, positions, tape, holders, leaderboard — and a Trade tab that places
> real orders via the user's own MetaMask. No custody, no backend secrets, no
> Polymarket Builder credentials required.

![terminal](docs/terminal.png)

## Why

Polymarket's UI is built for casual users. This is built for someone who wants
to watch a ticker, scan 10k events quickly, compare traders, and execute with
keyboard shortcuts.

- **Read-only is instant.** No wallet required to browse, search, watch live
  books, or study any trader's full position history.
- **Execution is self-custodial.** Connect MetaMask → the terminal derives
  your Polymarket Safe address deterministically, checks on-chain state, and
  lets you sign orders directly. No relayer. No trust.

## Stack

| Layer | Choice | Why |
|---|---|---|
| **Backend** | Rust + [axum](https://github.com/tokio-rs/axum) + [polyoxide](https://github.com/dilettante-trading/polyoxide) | Thin typed proxy over Polymarket's Gamma / CLOB / Data APIs + SSE fan-out for the live order book |
| **Frontend** | [SolidJS](https://www.solidjs.com/) + [Vite](https://vite.dev/) + Tailwind v4 + [TanStack Query](https://tanstack.com/query) | Fine-grained reactivity for a ticking book; no VDOM overhead |
| **Charts** | [lightweight-charts](https://github.com/tradingview/lightweight-charts) | Financial-grade time series at 60fps |
| **Wallet** | [viem](https://viem.sh/) + [@polymarket/clob-client](https://github.com/Polymarket/clob-client) | Browser-side EIP-712, no Node polyfills |
| **Data** | Polymarket Gamma (events/markets) • CLOB (book/orders) • Data (positions/trades/leaderboard) | All public, all proxied by the Rust backend |

## Features

**Markets mode**
- 10,000+ active markets, infinite-scrolled, keyboard-navigable (`j`/`k`)
- Full-text search across events *and* all nested markets via Polymarket's
  `/public-search` endpoint (debounced, paginated)
- Collapsible events — each expands to its outcomes with live prices
- Live order book (SSE → rAF-throttled, asset-id filtered, binary-search deltas)
- Live-ticking price chart (`last_trade` + mid-of-book fallback)
- Right-panel tabs: **Book / Tape / Holders / Trade**
  - *Tape* — recent trades feed (10s polling)
  - *Holders* — top YES/NO holders, click-through to trader view
  - *Trade* — wallet-gated order form with tick-size snapping
- Favorites (`f` toggles, pins to top, localStorage, cross-tab sync)
- Multiple chart intervals (1H / 6H / 1D / 1W / 1M / MAX)

**Traders mode**
- Leaderboard with infinite scroll up to 1000 traders
- Period × metric filters (1D / 1W / 1M / ALL · PnL / Volume)
- Click a trader → full view: open positions, closed positions, trades, activity
- Deterministic identicons for traders without profile pictures
- Click any position → jump to that market

**Wallet / Trading (optional)**
- Connect MetaMask, auto-derive Polymarket Safe via CREATE2
- Read `/api/user/:your-safe/*` → "Me" view shows your PnL + positions
- Order form with:
  - Outcome toggle (YES / NO)
  - Side toggle (BUY / SELL)
  - Tick-size snapping (pulled per-market from CLOB)
  - Live allowance display (`∞` for MaxUint256, actual $ otherwise)
  - Integer BigInt balance checks
- One-time **in-app Safe deployment + approvals** (all 7) via the user's own
  EOA — no relayer, costs ~0.2 MATIC in gas
- Open orders + cancel (polled every 10s)
- Error translation for common CLOB rejection codes

**Quality-of-life**
- URL routing (`/market/:slug`, `/trader/:addr`) — refresh-safe, shareable
- Global keyboard shortcuts: `/` (search) · `j/k` (nav) · `m/t` (mode switch) · `f` (favorite)
- Cross-tab favorite sync (`storage` event)
- Skeleton loaders for initial state
- Tabular-nums on all numeric columns, monospace everywhere

## Getting started

### Requirements
- **Rust** 1.88+ (`rustup update stable`)
- **Node** 20+
- (Optional for trading) **MetaMask** on Polygon + ~0.3 MATIC for first-time setup

### Run

```bash
# backend
cd backend && cargo run --release

# frontend (in another terminal)
cd frontend && npm install && npm run dev
```

Open <http://localhost:5174>.

### Building for production

```bash
# backend
cd backend && cargo build --release
# binary at backend/target/release/polymarket-terminal

# frontend
cd frontend && npm run build
# static files at frontend/dist/
```

The backend serves the API on `:8080` and expects the frontend to either be
served separately (Vite dev server, nginx, etc.) or to add a static-file
layer — see `vite.config.ts` for the dev-time proxy setup.

## Architecture notes

### Backend

- **Single binary** that wraps `polyoxide-{gamma, clob, data}` for read-only
  market data and `polyoxide-clob` with the `ws` feature for the live order
  book stream.
- `GET /api/stream/:tokenId` is a Server-Sent Events endpoint. Internally it
  spawns a `tokio` task that maintains a Polymarket WebSocket connection,
  filters messages by `asset_id`, and fans them out to the SSE client. Caps
  at 20 reconnect attempts with exponential backoff.
- All path/query inputs pass through `ensure_id()` — alphanumeric + `-`/`_`
  only, max-length-bounded. Limits on every pagination parameter.
- `rustls` with `ring` provider installed explicitly (polyoxide's WS client
  needs a crypto provider set before first use).
- `TimeoutLayer(20s)` on every route; `TraceLayer` for debug logs.

### Frontend

- **Single-page** Solid app, rendered into `#root`. Router from
  `@solidjs/router`; no SSR.
- State: TanStack Query for server state, `createSignal` for UI state,
  `localStorage` for favorites + wallet + cached L2 credentials.
- **Live order book**: `createLiveBook(tokenId)` in `src/lib/stream.ts`
  maintains two sorted arrays (bids descending, asks ascending) with O(log n)
  binary-search insert/delete on price-change deltas. Publishes on
  `requestAnimationFrame` with a `disposed` guard so rAF can't write into a
  torn-down effect.
- **Live-ticking chart**: `props.liveTick` on `<PriceChart>` is fed from the
  SSE stream (either `last_trade` or mid-of-book); throttled to 1Hz by
  `(time, price)` key.
- **Wallet**: viem-based. No wagmi dependency. `src/lib/wallet.ts` exposes a
  signal-based store and handles `accountsChanged` / `chainChanged` listeners.
- **Trading**: `@polymarket/clob-client` with a hand-written ethers-compat
  signer shim over viem. L2 credentials derived once via `deriveApiKey(0)`
  (falls back to `createApiKey(0)`), cached by Safe address. `useServerTime`
  is on to avoid client-clock 401s.
- **In-app Safe setup** (`src/lib/safeSetup.ts`): EIP-712 `CreateProxy` for
  factory deployment, pre-validated signature (type `0x01`) for the first
  Safe `execTransaction` — batches all 7 approvals via MultiSendCallOnly v1.3.0.

## Security / self-custody

- **No private key ever leaves the browser.** Every signature (credentials,
  orders, Safe exec) is an EIP-712 message signed by MetaMask.
- **No backend secrets.** The Rust service proxies to Polymarket public
  endpoints; it does not hold Polymarket Builder credentials, a relayer key,
  or any user wallet material.
- **Approvals are user-initiated.** The "Initialize Trading" flow explicitly
  shows that 2 transactions (Safe deploy + approval batch) will happen, the
  expected cost, and surfaces the user's MATIC balance before proceeding.
- **Tokens approved are scoped to Polymarket's exchanges** (USDC to
  `CTF_EXCHANGE` + `NEG_RISK_CTF_EXCHANGE` + `NEG_RISK_ADAPTER` + CTF,
  `setApprovalForAll` on CTF for the same three). Same approval set
  polymarket.com uses.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `/` | Focus search |
| `j` / `k` | Next / previous row in sidebar |
| `m` / `t` | Switch to Markets / Traders mode |
| `f` | Toggle favorite on current selection |
| `Esc` | Blur the focused input |

## Known limitations

- Chart interval granularity — live tick appends at 1s precision but
  lightweight-charts snaps to the interval; refresh the interval to flush the
  tail back into the fetched series.
- Market orders (FOK/FAK) and slippage guard — implementation plumbing is
  there but the UI only emits GTC limit orders right now.
- No position redemption UI (go to polymarket.com for resolved markets).
- Tested on MetaMask on Polygon; other wallets (Coinbase, Rabby) *should*
  work via EIP-1193 but not exercised.

## License

[MIT](./LICENSE) · © 2026 Nikshep SVN

---

**Not affiliated with Polymarket.** This is an independent third-party
client. Trade at your own risk. Prediction markets can go to zero.
