import { For, Show, createSignal } from 'solid-js'
import type { Market } from '../lib/api'
import {
  addAlert,
  alerts,
  removeAlert,
  toggleAlert,
  type AlertDirection,
  type PriceAlert,
} from '../lib/alerts'

type Props = {
  market: Market
  /** Current YES mid in 0..1, used to suggest a sensible default threshold. */
  currentYes: number | null
}

/**
 * Small bell affordance for MarketDetail. Click → popover that lists alerts
 * already set on this market, plus a one-line form to add another. Persists
 * to localStorage via the alert manager.
 */
export function MarketAlertButton(props: Props) {
  const [open, setOpen] = createSignal(false)
  const [direction, setDirection] = createSignal<AlertDirection>('above')
  const [outcomeIdx, setOutcomeIdx] = createSignal(0)
  const [thresholdStr, setThresholdStr] = createSignal('')
  const [rearm, setRearm] = createSignal(false)

  const mine = (): PriceAlert[] =>
    alerts().filter((a) => a.conditionId === props.market.conditionId)

  const defaultThreshold = (): string => {
    const y = props.currentYes
    if (y == null) return '50'
    const cents = y * 100
    const bump = direction() === 'above' ? 5 : -5
    return Math.max(1, Math.min(99, Math.round(cents + bump))).toString()
  }

  const submit = (e: Event) => {
    e.preventDefault()
    const raw = thresholdStr().trim() || defaultThreshold()
    const cents = Math.round(Number(raw))
    if (!Number.isFinite(cents) || cents <= 0 || cents >= 100) return
    const tokenId = props.market.clobTokenIds[outcomeIdx()]
    if (!tokenId) return
    const outcomeLabel =
      props.market.outcomes[outcomeIdx()] ?? (outcomeIdx() === 0 ? 'YES' : 'NO')
    addAlert({
      conditionId: props.market.conditionId,
      marketSlug: props.market.slug,
      marketTitle:
        props.market.groupItemTitle || props.market.question || 'market',
      tokenId,
      outcomeLabel,
      direction: direction(),
      thresholdCents: cents,
      rearm: rearm(),
    })
    setThresholdStr('')
  }

  return (
    <div class="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        class={
          'flex h-7 items-center gap-1.5 border px-2 text-[10px] uppercase tracking-[0.14em] ' +
          (mine().length > 0
            ? 'border-text-bright text-text-bright'
            : 'border-border-2 text-text-dim hover:text-text-bright')
        }
        title={mine().length > 0 ? `${mine().length} alert(s) on this market` : 'add price alert'}
      >
        🔔
        <Show when={mine().length > 0}>
          <span class="tabular-nums normal-case tracking-normal">
            {mine().length}
          </span>
        </Show>
      </button>
      <Show when={open()}>
        <div
          class="absolute right-0 top-8 z-30 w-72 border border-border-3 bg-panel p-3 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="eyebrow mb-2">alerts on this market</div>
          <Show when={mine().length === 0}>
            <div class="mb-3 text-[10px] text-text-dim">
              No alerts set. Add one below.
            </div>
          </Show>
          <Show when={mine().length > 0}>
            <div class="mb-3 flex flex-col gap-1.5">
              <For each={mine()}>
                {(a) => (
                  <div
                    class={
                      'flex items-center gap-2 border border-border-2 px-2 py-1 text-[11px] ' +
                      (a.active ? '' : 'opacity-50')
                    }
                  >
                    <span class="tabular-nums">
                      {a.outcomeLabel} {a.direction} {a.thresholdCents}¢
                    </span>
                    <Show when={a.rearm}>
                      <span
                        class="text-[9px] uppercase tracking-[0.14em] text-text-dim"
                        title="re-arms after firing"
                      >
                        ↻
                      </span>
                    </Show>
                    <button
                      onClick={() => toggleAlert(a.id)}
                      class="ml-auto cursor-pointer text-[10px] text-text-dim hover:text-text-bright"
                      title={a.active ? 'pause' : 'resume'}
                    >
                      {a.active ? '⏸' : '▶'}
                    </button>
                    <button
                      onClick={() => removeAlert(a.id)}
                      class="cursor-pointer text-[10px] text-text-dim hover:text-down"
                      title="delete"
                    >
                      ×
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <form onSubmit={submit} class="border-t border-border-2 pt-3">
            <div class="flex items-center gap-1.5 text-[10px]">
              <div class="segmented">
                <button
                  type="button"
                  data-active={outcomeIdx() === 0}
                  onClick={() => setOutcomeIdx(0)}
                >
                  {props.market.outcomes[0] ?? 'Yes'}
                </button>
                <Show when={props.market.clobTokenIds[1]}>
                  <button
                    type="button"
                    data-active={outcomeIdx() === 1}
                    onClick={() => setOutcomeIdx(1)}
                  >
                    {props.market.outcomes[1] ?? 'No'}
                  </button>
                </Show>
              </div>
              <div class="segmented">
                <button
                  type="button"
                  data-active={direction() === 'above'}
                  onClick={() => setDirection('above')}
                >
                  above
                </button>
                <button
                  type="button"
                  data-active={direction() === 'below'}
                  onClick={() => setDirection('below')}
                >
                  below
                </button>
              </div>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <input
                type="number"
                inputmode="decimal"
                min="1"
                max="99"
                step="1"
                placeholder={defaultThreshold()}
                value={thresholdStr()}
                onInput={(e) => setThresholdStr(e.currentTarget.value)}
                class="h-7 w-16 border border-border-2 bg-panel px-2 tabular-nums text-[11px] text-text-bright outline-none focus:border-border-3"
              />
              <span class="text-[10px] text-text-dim">¢</span>
              <label class="ml-auto flex cursor-pointer items-center gap-1.5 text-[10px] text-text-dim">
                <input
                  type="checkbox"
                  checked={rearm()}
                  onChange={(e) => setRearm(e.currentTarget.checked)}
                />
                re-arm
              </label>
            </div>
            <button
              type="submit"
              class="mt-2 h-7 w-full cursor-pointer border border-text-bright bg-text-bright text-[10px] font-semibold uppercase tracking-[0.14em] text-bg hover:bg-text hover:border-text"
            >
              add alert
            </button>
          </form>
          <button
            type="button"
            onClick={() => setOpen(false)}
            class="mt-2 block w-full cursor-pointer text-[10px] uppercase tracking-[0.14em] text-text-dim hover:text-text-bright"
          >
            close
          </button>
        </div>
      </Show>
    </div>
  )
}
