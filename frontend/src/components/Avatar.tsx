import { Show, createMemo, createSignal } from 'solid-js'

type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const SIZES: Record<Size, { box: string; text: string; px: number }> = {
  xs: { box: 'h-5 w-5', text: 'text-[8px]', px: 20 },
  sm: { box: 'h-6 w-6', text: 'text-[9px]', px: 24 },
  md: { box: 'h-8 w-8', text: 'text-[10px]', px: 32 },
  lg: { box: 'h-12 w-12', text: 'text-[13px]', px: 48 },
  xl: { box: 'h-14 w-14', text: 'text-[15px]', px: 56 },
}

type Props = {
  src?: string | null
  seed?: string
  size?: Size
  alt?: string
  shape?: 'square' | 'circle'
  /** Deterministic 5×5 identicon instead of initials on the fallback. Best
   *  for wallet addresses where initials carry no signal. */
  identicon?: boolean
}

/**
 * Monochrome avatar for thumbnails.
 * Shows the image when available, else a deterministic fallback derived from
 * `seed`: either 2-char initials or a 5×5 terminal-styled identicon.
 */
export function Avatar(props: Props) {
  // Track the specific src that failed — so when a virtualized row gets
  // reused with a new (valid) image, we don't hide it based on a stale
  // failure for a different URL.
  const [failedSrc, setFailedSrc] = createSignal<string | null>(null)
  const size = () => SIZES[props.size ?? 'md']
  const showImage = () => !!props.src && failedSrc() !== props.src

  const initials = () => {
    const s = (props.seed ?? '').trim()
    if (!s) return '?'
    if (s.startsWith('0x') && s.length >= 4) return s.slice(2, 4).toUpperCase()
    const parts = s.split(/[\s_-]+/).filter(Boolean)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase()
    }
    return s.slice(0, 2).toUpperCase()
  }

  const rounded = () => (props.shape === 'circle' ? 'rounded-full' : '')

  return (
    <Show
      when={showImage()}
      fallback={
        props.identicon ? (
          <Identicon
            seed={props.seed ?? ''}
            boxClass={`${size().box} ${rounded()}`}
            alt={props.alt ?? 'identicon'}
          />
        ) : (
          <div
            class={`${size().box} ${size().text} ${rounded()} shrink-0 flex items-center justify-center border border-border-2 bg-panel-2 font-semibold tracking-wider text-text-dim`}
            aria-label={props.alt ?? 'avatar'}
          >
            {initials()}
          </div>
        )
      }
    >
      <img
        src={props.src!}
        alt={props.alt ?? ''}
        loading="lazy"
        decoding="async"
        onError={() => setFailedSrc(props.src ?? null)}
        class={`${size().box} ${rounded()} shrink-0 border border-border-2 bg-panel-2 object-cover`}
      />
    </Show>
  )
}

/**
 * Deterministic 5×5 identicon. Cheap hash of the seed produces a sprite:
 *   - left 3 columns are random bits from the hash
 *   - mirrored to the right 2 columns for vertical-axis symmetry
 *     (looks deliberate, not random noise)
 *   - "on" cells use a single accent color (also hash-derived but clamped to
 *     a muted, terminal-safe palette)
 */
function Identicon(props: { seed: string; boxClass: string; alt: string }) {
  const model = createMemo(() => {
    const h = hashSeed(props.seed)
    // 5×5 grid, derive via 13 bits (3-col stripe × 5 rows minus center), then mirror
    const cells: boolean[][] = []
    let bits = h
    for (let y = 0; y < 5; y++) {
      const row: boolean[] = new Array(5)
      for (let x = 0; x < 3; x++) {
        row[x] = (bits & 1) === 1
        bits = bits >>> 1
        if (bits === 0) bits = hashSeed(props.seed + y + x) // reseed
      }
      row[3] = row[1]
      row[4] = row[0]
      cells.push(row)
    }
    const color = COLORS[h % COLORS.length]
    return { cells, color }
  })

  return (
    <div
      class={`${props.boxClass} shrink-0 overflow-hidden border border-border-2 bg-panel-2`}
      aria-label={props.alt}
    >
      <div class="grid h-full w-full grid-cols-5 grid-rows-5">
        {model().cells.flatMap((row, y) =>
          row.map((on, x) => (
            <span
              data-y={y}
              data-x={x}
              style={{ background: on ? model().color : 'transparent' }}
            />
          ))
        )}
      </div>
    </div>
  )
}

/** Small, muted palette — stays on-brand with the black-terminal aesthetic. */
const COLORS = [
  '#d4d4d4', // white
  '#00c972', // up
  '#ff3355', // down
  '#ffb000', // amber
  '#7d8590', // dim
  '#6b46c1', // muted purple (rare accent)
]

/**
 * FNV-1a 32-bit hash — cheap, deterministic, good enough for visual
 * differentiation. Returns unsigned int.
 */
function hashSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
