import { createSignal } from 'solid-js'

export type Toast = {
  id: string
  kind: 'alert' | 'info' | 'error'
  message: string
  /** Optional deep-link target (market slug). Container renders a CTA. */
  marketSlug?: string
}

const [_toasts, _setToasts] = createSignal<Toast[]>([])
export const toasts = _toasts

let _seq = 0
const nextId = () => `${Date.now()}-${++_seq}`

export function showToast(t: Omit<Toast, 'id'>, ttlMs = 6000) {
  const id = nextId()
  const full: Toast = { ...t, id }
  _setToasts((cur) => [...cur, full])
  if (ttlMs > 0) {
    window.setTimeout(() => {
      _setToasts((cur) => cur.filter((x) => x.id !== id))
    }, ttlMs)
  }
}

export function dismissToast(id: string) {
  _setToasts((cur) => cur.filter((x) => x.id !== id))
}
