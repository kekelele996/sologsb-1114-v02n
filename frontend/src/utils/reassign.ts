import type { Segment, Sketch } from '@/types'
import { stakeToNumber } from '@/utils/survey'

/** 判断锚点桩号是否落在洞段起止区间内（含端点） */
export function anchorWithinSegment(anchorStake: string, segment: Pick<Segment, 'startStake' | 'endStake'>): boolean {
  const anchor = stakeToNumber(anchorStake)
  const lo = stakeToNumber(segment.startStake)
  const hi = stakeToNumber(segment.endStake)
  return anchor >= Math.min(lo, hi) && anchor <= Math.max(lo, hi)
}

/** 按锚点桩号在洞段清单中查找包含它的洞段，找不到返回 null */
export function findSegmentByAnchor(anchorStake: string, segments: Segment[]): Segment | null {
  return segments.find((segment) => anchorWithinSegment(anchorStake, segment)) ?? null
}

/** 桩号变更后，挑出该洞段下锚点落到新区间外的图幅 */
export function sketchesOutOfSegment(segment: Segment, sketches: Sketch[]): Sketch[] {
  return sketches.filter(
    (sketch) => sketch.segmentId === segment.id && !anchorWithinSegment(sketch.anchorStake, segment)
  )
}
