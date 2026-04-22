import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import {
  useLocation,
  useNavigate,
  useParams,
} from '@solidjs/router'
import {
  createInfiniteQuery,
  createQuery,
  keepPreviousData,
} from '@tanstack/solid-query'
import {
  api,
  type Event,
  type Market,
  type TraderRanking,
} from './lib/api'
import { favorites } from './lib/favorites'
import { MarketList } from './components/MarketList'
import { MarketDetail } from './components/MarketDetail'
import { TraderList } from './components/TraderList'
import { TraderDetail } from './components/TraderDetail'
import { WalletButton } from './components/WalletButton'
import { initWalletAutoReconnect } from './lib/wallet'

const PAGE_SIZE = 250
const LEADERBOARD_PAGE = 50

type Mode = 'markets' | 'traders'

export default function Shell(props: { children?: JSX.Element }) {
  void props // Router passes children but we render based on path directly.
  const location = useLocation()
  const params = useParams<{ slug?: string; addr?: string }>()
  const navigate = useNavigate()

  // Silently reconnect the wallet if the user authorized us in a prior session.
  initWalletAutoReconnect()

  const mode = (): Mode =>
    location.pathname.startsWith('/trader') ? 'traders' : 'markets'

  // --- markets state ---
  const [filter, setFilter] = createSignal('')
  const [debouncedFilter, setDebouncedFilter] = createSignal('')

  createEffect(() => {
    const f = filter().trim()
    const t = window.setTimeout(() => setDebouncedFilter(f), 200)
    onCleanup(() => window.clearTimeout(t))
  })

  const searching = () =>
    debouncedFilter().length > 0 && mode() === 'markets'

  const eventsQuery = createInfiniteQuery(() => ({
    queryKey: ['events'],
    queryFn: ({ pageParam, signal }) =>
      api.eventsPage(pageParam, PAGE_SIZE, signal),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.length * PAGE_SIZE,
    staleTime: 60_000,
    refetchInterval: false,
    // Cap retained pages so load-more doesn't accumulate unbounded memory.
    maxPages: 20,
  }))

  const searchQuery = createQuery(() => ({
    queryKey: ['search', debouncedFilter()],
    queryFn: ({ signal }) =>
      api.searchEvents(debouncedFilter(), 1, 40, signal),
    enabled: searching(),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  }))

  const browsingEvents = createMemo<Event[]>(() =>
    (eventsQuery.data?.pages ?? []).flat()
  )
  const rawEvents = createMemo<Event[]>(() =>
    searching() ? (searchQuery.data?.events ?? []) : browsingEvents()
  )
  const events = createMemo<Event[]>(() =>
    rawEvents()
      .map((e) => ({
        ...e,
        markets: e.markets.filter(
          (m) => m.enableOrderBook && !m.closed && m.clobTokenIds.length > 0
        ),
      }))
      .filter((e) => e.markets.length > 0)
  )
  const flatMarkets = createMemo<Market[]>(() =>
    events().flatMap((e) => e.markets)
  )

  // Slug → Market lookup. Try local cache first, else hit the API.
  const marketSlugQuery = createQuery(() => ({
    queryKey: ['market-by-slug', params.slug],
    queryFn: ({ signal }) => api.getMarketBySlug(params.slug!, signal),
    enabled: !!params.slug,
    staleTime: 5 * 60_000,
  }))

  const selectedMarket = createMemo<Market | undefined>(() => {
    const slug = params.slug
    if (!slug) return undefined
    // Prefer the list copy so live field updates flow through.
    const inList = flatMarkets().find((m) => m.slug === slug)
    return inList ?? marketSlugQuery.data ?? undefined
  })

  const selectedEvent = createMemo(() => {
    const m = selectedMarket()
    if (!m) return undefined
    return events().find((e) => e.markets.some((x) => x.id === m.id))
  })

  const loadMore = () => {
    if (
      !searching() &&
      eventsQuery.hasNextPage &&
      !eventsQuery.isFetchingNextPage
    ) {
      eventsQuery.fetchNextPage()
    }
  }

  // --- traders state ---
  const [traderFilter, setTraderFilter] = createSignal('')
  const [period, setPeriod] = createSignal<'day' | 'week' | 'month' | 'all'>(
    'week'
  )
  const [orderBy, setOrderBy] = createSignal<'pnl' | 'vol'>('pnl')

  const leaderboardQuery = createInfiniteQuery(() => ({
    queryKey: ['leaderboard', period(), orderBy()],
    queryFn: ({ pageParam, signal }) =>
      api.leaderboard(
        {
          period: period(),
          orderBy: orderBy(),
          limit: LEADERBOARD_PAGE,
          offset: pageParam,
        },
        signal
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < LEADERBOARD_PAGE) return undefined
      const next = allPages.length * LEADERBOARD_PAGE
      return next >= 1000 ? undefined : next
    },
    enabled: mode() === 'traders',
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    maxPages: 20,
  }))

  const traders = createMemo<TraderRanking[]>(() =>
    (leaderboardQuery.data?.pages ?? []).flat()
  )

  const selectedTrader = createMemo<TraderRanking | undefined>(() => {
    const addr = params.addr
    if (!addr) return undefined
    const found = traders().find(
      (t) => t.proxyWallet.toLowerCase() === addr.toLowerCase()
    )
    if (found) return found
    // Stand-in ranking so the detail view can render even when the address
    // isn't in the currently-loaded leaderboard page.
    return {
      rank: '—',
      proxyWallet: addr,
      userName: null,
      vol: 0,
      pnl: 0,
      profileImage: null,
      xUsername: null,
      verifiedBadge: null,
    }
  })

  const loadMoreTraders = () => {
    if (
      leaderboardQuery.hasNextPage &&
      !leaderboardQuery.isFetchingNextPage
    ) {
      leaderboardQuery.fetchNextPage()
    }
  }

  // Default selection if none in URL.
  createEffect(() => {
    if (mode() !== 'markets') return
    if (params.slug) return
    if (eventsQuery.isPending) return
    const first = flatMarkets()[0]
    if (first && first.slug) {
      navigate(`/market/${first.slug}`, { replace: true })
    }
  })
  createEffect(() => {
    if (mode() !== 'traders') return
    if (params.addr) return
    // Wait until leaderboard has real data, else we'd navigate to
    // `/trader/undefined`.
    if (leaderboardQuery.isPending) return
    const first = traders()[0]
    if (first && first.proxyWallet) {
      navigate(`/trader/${first.proxyWallet}`, { replace: true })
    }
  })

  // --- shared header ---
  const initialLoading = () =>
    mode() === 'markets'
      ? searching()
        ? searchQuery.isPending && !searchQuery.data
        : eventsQuery.isPending && !eventsQuery.data
      : leaderboardQuery.isPending && !leaderboardQuery.data
  const refetching = () =>
    mode() === 'markets'
      ? searching()
        ? searchQuery.isFetching && !!searchQuery.data
        : eventsQuery.isFetchingNextPage
      : leaderboardQuery.isFetchingNextPage
  const listError = () =>
    mode() === 'markets'
      ? searching()
        ? searchQuery.error
        : eventsQuery.error
      : leaderboardQuery.error
  const hasMore = () =>
    mode() === 'markets' && !searching() && !!eventsQuery.hasNextPage

  const headerCount = () =>
    mode() === 'markets'
      ? `${events().length} events · ${flatMarkets().length} markets`
      : `${traders().length} traders`

  // --- keyboard nav ---
  let searchInputRef: HTMLInputElement | undefined
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing =
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      if (e.key === 'Escape' && typing) {
        ;(t as HTMLElement).blur()
        return
      }
      if (typing) return
      if (e.key === '/') {
        e.preventDefault()
        searchInputRef?.focus()
        return
      }
      if (e.key === 'm') {
        e.preventDefault()
        navigate('/markets')
      } else if (e.key === 't') {
        e.preventDefault()
        navigate('/traders')
      } else if (e.key === 'f') {
        // Toggle favorite on the current selection.
        if (mode() === 'markets' && selectedMarket()) {
          favorites.toggleMarket(selectedMarket()!.id)
        } else if (mode() === 'traders' && selectedTrader()) {
          favorites.toggleTrader(selectedTrader()!.proxyWallet)
        }
      } else if (e.key === 'j' || e.key === 'k') {
        e.preventDefault()
        const dir = e.key === 'j' ? 1 : -1
        if (mode() === 'markets') {
          const list = flatMarkets()
          if (!list.length) return
          const cur = list.findIndex((m) => m.id === selectedMarket()?.id)
          const next =
            cur < 0 ? 0 : Math.min(Math.max(cur + dir, 0), list.length - 1)
          navigate(`/market/${list[next].slug}`, { replace: true })
        } else {
          const list = traders()
          if (!list.length) return
          const cur = list.findIndex(
            (t) => t.proxyWallet === selectedTrader()?.proxyWallet
          )
          const next =
            cur < 0 ? 0 : Math.min(Math.max(cur + dir, 0), list.length - 1)
          navigate(`/trader/${list[next].proxyWallet}`, { replace: true })
        }
      }
    }
    window.addEventListener('keydown', handler)
    onCleanup(() => window.removeEventListener('keydown', handler))
  })

  return (
    <div class="flex h-screen flex-col bg-bg">
      <header class="flex h-10 shrink-0 items-center justify-between border-b border-border-2 px-4">
        <div class="flex items-center gap-5">
          <div class="flex items-center gap-2">
            <span class="inline-block h-2 w-2 bg-text-bright" />
            <span class="text-[11px] font-semibold uppercase tracking-[0.25em] text-text-bright">
              humanplane
            </span>
          </div>
          <span class="h-3.5 w-px bg-border-2" />
          <div class="segmented">
            <button
              data-active={mode() === 'markets'}
              onClick={() => navigate('/markets')}
            >
              Markets
            </button>
            <button
              data-active={mode() === 'traders'}
              onClick={() => navigate('/traders')}
            >
              Traders
            </button>
          </div>
          <div class="flex items-center gap-2 text-[10px] text-text-dim">
            <span class="live-dot inline-block h-1.5 w-1.5 bg-up" />
            <span class="tabular-nums">{headerCount()}</span>
            <Show when={mode() === 'markets' && searching()}>
              <span class="text-text-bright">
                · matching “{debouncedFilter()}”
              </span>
            </Show>
            <Show when={refetching()}>
              <span class="text-text-bright">· syncing…</span>
            </Show>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <div class="hidden items-center gap-3 text-[9px] uppercase tracking-[0.14em] text-text-dim md:flex">
            <span>/ search</span>
            <span>j k nav</span>
            <span>f fav</span>
            <span>m/t mode</span>
          </div>
          <WalletButton />
        </div>
      </header>

      <div class="flex min-h-0 flex-1">
        <aside class="flex w-[380px] shrink-0 flex-col border-r border-border-2">
          <Show
            when={mode() === 'markets'}
            fallback={
              <TraderList
                ref={(el) => (searchInputRef = el)}
                traders={traders()}
                loading={initialLoading()}
                period={period()}
                orderBy={orderBy()}
                onPeriodChange={setPeriod}
                onOrderByChange={setOrderBy}
                selectedWallet={selectedTrader()?.proxyWallet}
                onSelect={(t) => navigate(`/trader/${t.proxyWallet}`)}
                filter={traderFilter()}
                onFilterChange={setTraderFilter}
                hasMore={!!leaderboardQuery.hasNextPage}
                loadingMore={leaderboardQuery.isFetchingNextPage}
                onLoadMore={loadMoreTraders}
              />
            }
          >
            <Show
              when={!initialLoading()}
              fallback={
                <MarketList
                  ref={(el) => (searchInputRef = el)}
                  events={[]}
                  selectedMarketId={selectedMarket()?.id}
                  onSelect={(m) => navigate(`/market/${m.slug}`)}
                  filter={filter()}
                  onFilterChange={setFilter}
                  hasMore={false}
                  loadingMore={true}
                  onLoadMore={() => {}}
                  searching={searching()}
                />
              }
            >
              <Show
                when={!listError()}
                fallback={
                  <div class="p-4 text-[11px] text-down">
                    ERR: {(listError() as Error)?.message}
                  </div>
                }
              >
                <MarketList
                  ref={(el) => (searchInputRef = el)}
                  events={events()}
                  selectedMarketId={selectedMarket()?.id}
                  onSelect={(m) => navigate(`/market/${m.slug}`)}
                  filter={filter()}
                  onFilterChange={setFilter}
                  hasMore={hasMore()}
                  loadingMore={refetching()}
                  onLoadMore={loadMore}
                  searching={searching()}
                />
              </Show>
            </Show>
          </Show>
        </aside>

        <main class="flex min-w-0 flex-1 flex-col">
          <Show
            when={mode() === 'markets'}
            fallback={
              <Show
                when={selectedTrader()}
                fallback={
                  <div class="flex h-full items-center justify-center eyebrow">
                    select a trader
                  </div>
                }
              >
                {(t) => <TraderDetail trader={t()} />}
              </Show>
            }
          >
            <Show
              when={selectedMarket()}
              fallback={
                <div class="flex h-full items-center justify-center eyebrow">
                  <Show
                    when={!marketSlugQuery.isLoading}
                    fallback={<span>loading…</span>}
                  >
                    {searching()
                      ? 'no match — pick a market'
                      : 'select a market'}
                  </Show>
                </div>
              }
            >
              {(m) => <MarketDetail market={m()} event={selectedEvent()} />}
            </Show>
          </Show>
        </main>
      </div>
    </div>
  )
}

// Expose an unused helper to suppress unused-import warnings if any.
const _For = For
void _For
