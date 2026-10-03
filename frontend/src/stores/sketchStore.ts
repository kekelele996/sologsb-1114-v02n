import { createStore } from 'zustand/vanilla'
import type { Segment, Sketch } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { findSegmentByAnchor, sketchesOutOfSegment } from '@/utils/reassign'

export interface ReassignResult {
  /** 重配成功、已挂回洞段的图幅 */
  reassigned: Sketch[]
  /** 锚点仍落不到任何区间的图幅（保持原锚点与偏移，留待下次重试） */
  failed: Sketch[]
}

export interface SketchState {
  sketches: Sketch[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (sketch: Sketch) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (orderedIds: string[]) => Promise<void>
  /** 桩号变更后，把锚点落到新区间外的图幅标记为待重配，返回失效图幅数 */
  markOutOfRangePending: (segment: Segment) => Promise<number>
  /** 按锚点重配待处理图幅；异常时按侧恢复（草图侧回滚快照，洞段侧不动） */
  reassignPending: (segments: Segment[]) => Promise<ReassignResult>
  /** 持久化图幅对齐偏移（拼合视图拖动 / 锚点吸附后写回） */
  setAlignOffsets: (offsets: Record<string, number>) => Promise<void>
}

export const sketchStore = createStore<SketchState>((set, get) => ({
  sketches: [],
  loaded: false,
  hydrate: async () => {
    const sketches = await syncAll<Sketch>(db.sketches)
    sketches.sort((a, b) => a.mergeOrder - b.mergeOrder)
    set({ sketches, loaded: true })
  },
  save: async (sketch) => {
    await syncPut<Sketch>(db.sketches, sketch)
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete(db.sketches, id)
    await get().hydrate()
  },
  reorder: async (orderedIds) => {
    const all = get().sketches
    await Promise.all(
      orderedIds.map((id, index) => {
        const target = all.find((item) => item.id === id)
        return target ? syncPut<Sketch>(db.sketches, { ...target, mergeOrder: index + 1 }) : Promise.resolve()
      })
    )
    await get().hydrate()
  },
  markOutOfRangePending: async (segment) => {
    // 只翻动状态标记，锚点与对齐偏移保持原样；区间里的测点不受影响，闭合差照算
    const targets = sketchesOutOfSegment(segment, get().sketches).filter((item) => item.anchorStatus !== 'pending')
    await Promise.all(targets.map((item) => syncPut<Sketch>(db.sketches, { ...item, anchorStatus: 'pending' })))
    if (targets.length > 0) await get().hydrate()
    return targets.length
  },
  reassignPending: async (segments) => {
    // 只处理待重配的图幅：上次失败的留在队列里，这次只重试那几张
    const pending = get().sketches.filter((item) => item.anchorStatus === 'pending')
    const snapshot = pending.map((item) => ({ ...item }))
    const result: ReassignResult = { reassigned: [], failed: [] }
    try {
      for (const sketch of pending) {
        const hit = findSegmentByAnchor(sketch.anchorStake, segments)
        if (hit) {
          // 命中区间：只回填所属洞段与状态，锚点与对齐偏移原样保留
          const next: Sketch = { ...sketch, segmentId: hit.id, anchorStatus: 'ok' }
          await syncPut<Sketch>(db.sketches, next)
          result.reassigned.push(next)
        } else {
          result.failed.push(sketch)
        }
      }
    } catch (error) {
      // 按侧恢复：草图侧回滚到重配前快照（保住原锚点与偏移）；
      // 洞段档案不在本次写范围内，新桩号自然留住
      await Promise.all(snapshot.map((item) => syncPut<Sketch>(db.sketches, item)))
      await get().hydrate()
      throw error
    }
    await get().hydrate()
    return result
  },
  setAlignOffsets: async (offsets) => {
    const all = get().sketches
    await Promise.all(
      Object.entries(offsets).map(([id, alignOffset]) => {
        const target = all.find((item) => item.id === id)
        return target && target.alignOffset !== alignOffset
          ? syncPut<Sketch>(db.sketches, { ...target, alignOffset })
          : Promise.resolve()
      })
    )
    await get().hydrate()
  }
}))
