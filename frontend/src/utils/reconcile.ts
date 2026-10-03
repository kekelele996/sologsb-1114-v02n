import type { Segment, Sketch } from '@/types'
import { stakeToNumber } from './survey'

/** 锚点桩号是否落在洞段起止桩号区间内（含边界） */
export function anchorInSegment(anchorStake: string, segment: Segment): boolean {
  const anchor = stakeToNumber(anchorStake)
  const lo = Math.min(stakeToNumber(segment.startStake), stakeToNumber(segment.endStake))
  const hi = Math.max(stakeToNumber(segment.startStake), stakeToNumber(segment.endStake))
  return anchor >= lo && anchor <= hi
}

/** 按锚点桩号找所属洞段：锚点落在哪个洞段区间内就归哪个洞段（用于旧数据回填） */
export function findSegmentForAnchor(anchorStake: string, segments: Segment[]): Segment | undefined {
  return segments.find((segment) => anchorInSegment(anchorStake, segment))
}

/**
 * 草图锚点状态（派生）：
 * - 有所属区间 且 锚点在该区间内 → 'ok'
 * - 其余（无区间 / 区间外 / 区间被删）→ 'pending'，等待重配
 */
export function deriveReconcileStatus(sketch: Sketch, segments: Segment[]): 'ok' | 'pending' {
  if (!sketch.segmentId) return 'pending'
  const segment = segments.find((item) => item.id === sketch.segmentId)
  if (!segment) return 'pending'
  return anchorInSegment(sketch.anchorStake, segment) ? 'ok' : 'pending'
}
