import { createStore } from 'zustand/vanilla'
import type { Sketch } from '@/types'
import { db, syncPut } from '@/hooks/usePersistentStore'
import { anchorInSegment, deriveReconcileStatus, findSegmentForAnchor } from '@/utils/reconcile'

export interface ReconcileState {
  /** 待重配图幅（锚点失效 / 旧数据未回填 / 重配失败） */
  pendingSketches: Sketch[]
  loaded: boolean
  refresh: () => Promise<void>
  /** 旧数据升级：给没记所属区间的草图按锚点回填 segmentId，回填不上的单独留着 */
  backfillOrphans: () => Promise<{ matched: number; kept: number }>
  /** 桩号改动后：把该洞段锚点落区间外的图幅挑出来标记待重配（不动锚点与偏移） */
  invalidateSegmentSketches: (segmentId: string) => Promise<number>
  /** 重试重配：只处理待重配图幅；失败时保住原锚点与偏移，下次只重试这几张 */
  retryPending: (ids?: string[]) => Promise<{ fixed: number; failed: number }>
}

export const reconcileStore = createStore<ReconcileState>((set, get) => ({
  pendingSketches: [],
  loaded: false,
  refresh: async () => {
    const [sketches, segments] = await Promise.all([db.sketches.toArray(), db.segments.toArray()])
    const pending = sketches.filter((sketch) => {
      if (sketch.reconcileStatus === 'pending' || sketch.reconcileStatus === 'failed') return true
      return deriveReconcileStatus(sketch, segments) === 'pending'
    })
    set({ pendingSketches: pending, loaded: true })
  },
  backfillOrphans: async () => {
    const [sketches, segments] = await Promise.all([db.sketches.toArray(), db.segments.toArray()])
    const orphans = sketches.filter((sketch) => !sketch.segmentId)
    let matched = 0
    let kept = 0
    await Promise.all(
      orphans.map(async (sketch) => {
        const target = findSegmentForAnchor(sketch.anchorStake, segments)
        if (target) {
          // 按锚点回填上了：归入区间，锚点与偏移保留
          await syncPut<Sketch>(db.sketches, {
            ...sketch,
            segmentId: target.id,
            reconcileStatus: 'ok',
            reconcileReason: ''
          })
          matched++
        } else {
          // 回填不上的单独留着，等重配
          await syncPut<Sketch>(db.sketches, {
            ...sketch,
            reconcileStatus: 'pending',
            reconcileReason: '旧数据未记录所属区间，按锚点回填失败，待重配'
          })
          kept++
        }
      })
    )
    await get().refresh()
    return { matched, kept }
  },
  invalidateSegmentSketches: async (segmentId) => {
    const [sketches, segments] = await Promise.all([db.sketches.toArray(), db.segments.toArray()])
    const segment = segments.find((item) => item.id === segmentId)
    if (!segment) {
      await get().refresh()
      return 0
    }
    let count = 0
    await Promise.all(
      sketches
        .filter((sketch) => sketch.segmentId === segmentId)
        .map(async (sketch) => {
          if (!anchorInSegment(sketch.anchorStake, segment)) {
            // 锚点落区间外：挑出来待重配。按侧恢复——洞段留住新桩号（已独立持久化），
            // 图幅保住原锚点与偏移，这里只改状态与说明。
            await syncPut<Sketch>(db.sketches, {
              ...sketch,
              reconcileStatus: 'pending',
              reconcileReason: `桩号调整后锚点 ${sketch.anchorStake} 落区间外（${segment.startStake} → ${segment.endStake}），待重配`
            })
            count++
          }
        })
    )
    await get().refresh()
    return count
  },
  retryPending: async (ids) => {
    const [sketches, segments] = await Promise.all([db.sketches.toArray(), db.segments.toArray()])
    const queue = sketches.filter((sketch) => {
      if (ids && !ids.includes(sketch.id)) return false
      if (sketch.reconcileStatus === 'pending' || sketch.reconcileStatus === 'failed') return true
      return deriveReconcileStatus(sketch, segments) === 'pending'
    })
    let fixed = 0
    let failed = 0
    await Promise.all(
      queue.map(async (sketch) => {
        const target = findSegmentForAnchor(sketch.anchorStake, segments)
        if (target) {
          // 重配成功：归入新洞段，锚点与偏移保留
          await syncPut<Sketch>(db.sketches, {
            ...sketch,
            segmentId: target.id,
            reconcileStatus: 'ok',
            reconcileReason: ''
          })
          fixed++
        } else {
          // 重配失败：按侧恢复——洞段留住新桩号，图幅保住原锚点与偏移，下次只重试这几张
          await syncPut<Sketch>(db.sketches, {
            ...sketch,
            reconcileStatus: 'failed',
            reconcileReason: `未找到包含锚点 ${sketch.anchorStake} 的洞段，保留原锚点与偏移，待下次重试`
          })
          failed++
        }
      })
    )
    await get().refresh()
    return { fixed, failed }
  }
}))
