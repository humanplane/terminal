import { For, Show } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { dismissToast, toasts, type Toast } from '../lib/toast'

const toneByKind = (k: Toast['kind']) =>
  k === 'alert'
    ? 'border-text-bright text-text-bright'
    : k === 'error'
      ? 'border-down/70 text-down'
      : 'border-border-3 text-text'

export function ToastContainer() {
  const navigate = useNavigate()
  return (
    <div class="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[340px] flex-col gap-2">
      <For each={toasts()}>
        {(t) => (
          <div
            class={
              'pointer-events-auto flex items-start gap-3 border bg-panel p-3 text-[11px] shadow-2xl ' +
              toneByKind(t.kind)
            }
          >
            <div class="min-w-0 flex-1">
              <div class="break-words leading-snug">{t.message}</div>
              <Show when={t.marketSlug}>
                <button
                  onClick={() => {
                    navigate(`/market/${t.marketSlug}`)
                    dismissToast(t.id)
                  }}
                  class="mt-1 cursor-pointer text-[10px] uppercase tracking-[0.14em] text-text-dim hover:text-text-bright"
                >
                  open market →
                </button>
              </Show>
            </div>
            <button
              onClick={() => dismissToast(t.id)}
              class="shrink-0 cursor-pointer text-[14px] leading-none text-text-dim hover:text-text-bright"
              aria-label="dismiss"
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
