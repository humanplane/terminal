import { For, Show, createMemo } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { createQuery } from '@tanstack/solid-query'
import { api, type Holder, type Market } from '../lib/api'
import { fmtNum } from '../lib/format'
import { Avatar } from './Avatar'

type Props = {
  market: Market
}

export function TopHolders(props: Props) {
  const navigate = useNavigate()

  const holdersQ = createQuery(() => ({
    queryKey: ['holders', props.market.conditionId],
    queryFn: ({ signal }) =>
      api.topHolders(
        props.market.conditionId,
        { limit: 10, minBalance: 10 },
        signal
      ),
    enabled: !!props.market.conditionId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  }))

  // Response: one entry per token (YES, NO) with its top N holders.
  const yesToken = () => props.market.clobTokenIds[0]
  const noToken = () => props.market.clobTokenIds[1]

  const grouped = createMemo(() => {
    const data = holdersQ.data ?? []
    return {
      yes: data.find((d) => d.token === yesToken())?.holders ?? [],
      no: data.find((d) => d.token === noToken())?.holders ?? [],
    }
  })

  const labels = () => ({
    yes: props.market.outcomes[0] ?? 'Yes',
    no: props.market.outcomes[1] ?? 'No',
  })

  return (
    <div class="flex h-full flex-col">
      <div class="flex h-7 shrink-0 items-center justify-between border-b border-border px-3 eyebrow">
        <span>top holders</span>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show
          when={!holdersQ.isLoading}
          fallback={<div class="p-3 eyebrow">loading…</div>}
        >
          <Show
            when={grouped().yes.length || grouped().no.length}
            fallback={<div class="p-3 eyebrow">no holders data</div>}
          >
            <HolderGroup
              label={labels().yes}
              tone="up"
              holders={grouped().yes}
              onPick={(addr) => navigate(`/trader/${addr}`)}
            />
            <HolderGroup
              label={labels().no}
              tone="down"
              holders={grouped().no}
              onPick={(addr) => navigate(`/trader/${addr}`)}
            />
          </Show>
        </Show>
      </div>
    </div>
  )
}

function HolderGroup(props: {
  label: string
  tone: 'up' | 'down'
  holders: Holder[]
  onPick: (addr: string) => void
}) {
  const toneCls = () => (props.tone === 'up' ? 'text-up' : 'text-down')
  return (
    <Show when={props.holders.length}>
      <div
        class={
          'flex h-6 items-center gap-2 border-b border-border-subtle bg-panel px-3 eyebrow ' +
          toneCls()
        }
      >
        {props.label}
        <span class="text-text-dim">· {props.holders.length}</span>
      </div>
      <For each={props.holders}>
        {(h) => <HolderRow h={h} onPick={() => props.onPick(h.proxyWallet)} />}
      </For>
    </Show>
  )
}

function HolderRow(props: { h: Holder; onPick: () => void }) {
  const name = () =>
    props.h.name ||
    props.h.pseudonym ||
    shortAddr(props.h.proxyWallet)
  return (
    <button
      onClick={props.onPick}
      class="flex h-9 w-full cursor-pointer items-center gap-2.5 border-b border-border-subtle px-3 text-left hover:bg-panel"
    >
      <Avatar
        src={props.h.profileImage}
        seed={props.h.pseudonym ?? props.h.proxyWallet}
        size="sm"
        shape="circle"
        identicon
      />
      <div class="min-w-0 flex-1 truncate text-[11px] text-text-bright">
        {name()}
      </div>
      <div class="shrink-0 tabular-nums text-[11px] text-text">
        {fmtNum(props.h.amount)}
      </div>
    </button>
  )
}

function shortAddr(a: string) {
  if (!a) return ''
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
