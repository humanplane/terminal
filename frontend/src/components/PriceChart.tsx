import { createEffect, onCleanup, onMount } from 'solid-js'
import {
  AreaSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts'
import type { HistoryPoint } from '../lib/api'

type Props = {
  data: HistoryPoint[] | undefined
  // Optional live tick — when this changes, a new point is appended to the
  // series (or the current trailing point updated if the time matches).
  liveTick?: { t: number; p: number } | null
}

function toSeriesData(d: HistoryPoint[]) {
  const points = d
    .map((p) => ({ time: p.t as Time, value: p.p }))
    .sort((a, b) => (a.time as number) - (b.time as number))
  const unique: typeof points = []
  let lastT = -Infinity
  for (const p of points) {
    const t = p.time as number
    if (t <= lastT) continue
    unique.push(p)
    lastT = t
  }
  return unique
}

export function PriceChart(props: Props) {
  let containerRef!: HTMLDivElement
  let chart: IChartApi | null = null
  let series: ISeriesApi<'Area'> | null = null
  let mounted = false
  let lastTime = 0

  const applyData = () => {
    if (!series || !props.data) return
    const data = toSeriesData(props.data)
    series.setData(data)
    lastTime = data.length ? (data[data.length - 1].time as number) : 0
    chart?.timeScale().fitContent()
  }

  const applyTick = (tick: { t: number; p: number }) => {
    if (!series || !tick) return
    // Clamp tick time strictly monotonic — lightweight-charts requires
    // non-decreasing timestamps, and updates replace the last bar when
    // the time is equal to the current last.
    const t = Math.max(tick.t, lastTime) as Time
    series.update({ time: t, value: tick.p })
    lastTime = Math.max(lastTime, tick.t)
  }

  onMount(() => {
    chart = createChart(containerRef, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: '#7d8590',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(38, 38, 38, 0.5)' },
        horzLines: { color: 'rgba(38, 38, 38, 0.5)' },
      },
      rightPriceScale: {
        borderColor: '#1f1f1f',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: '#1f1f1f',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: '#2e2e2e', labelBackgroundColor: '#0a0a0a' },
        horzLine: { color: '#2e2e2e', labelBackgroundColor: '#0a0a0a' },
      },
    })

    series = chart.addSeries(AreaSeries, {
      lineColor: '#ffffff',
      topColor: 'rgba(255, 255, 255, 0.18)',
      bottomColor: 'rgba(255, 255, 255, 0.01)',
      lineWidth: 2,
      priceFormat: {
        type: 'custom',
        formatter: (p: number) => `${(p * 100).toFixed(1)}¢`,
        minMove: 0.001,
      },
    })

    applyData()
    mounted = true
  })

  createEffect(() => {
    void props.data
    // Skip the initial run — onMount already called applyData with this data.
    // Subsequent runs (on data refetch / interval change) flow through here.
    if (mounted) applyData()
  })

  // Live tick appender. Reads `props.liveTick` reactively; when a new trade
  // arrives from the SSE stream we push it onto the series.
  createEffect(() => {
    const tick = props.liveTick
    if (!mounted || !tick) return
    applyTick(tick)
  })

  onCleanup(() => {
    chart?.remove()
  })

  return <div ref={containerRef!} class="absolute inset-0" />
}
