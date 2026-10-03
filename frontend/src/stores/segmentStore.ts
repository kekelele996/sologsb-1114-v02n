import { createStore } from 'zustand/vanilla'
import type { Segment, SegmentType } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { sketchStore } from '@/stores/sketchStore'

export interface SegmentState {
  segments: Segment[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 保存洞段；若起止桩号有改动，返回锚点失效转入待重配的图幅数 */
  save: (segment: Segment) => Promise<number>
  remove: (id: string) => Promise<void>
  removeByCave: (caveId: string) => Promise<void>
  bulkSetType: (ids: string[], type: SegmentType) => Promise<void>
  bulkSetClosed: (ids: string[], closed: boolean) => Promise<void>
}

export const segmentStore = createStore<SegmentState>((set, get) => ({
  segments: [],
  loaded: false,
  hydrate: async () => {
    const segments = await syncAll<Segment>(db.segments)
    segments.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
    set({ segments, loaded: true })
  },
  save: async (segment) => {
    const before = get().segments.find((item) => item.id === segment.id)
    await syncPut<Segment>(db.segments, segment)
    await get().hydrate()
    // 桩号一改动：落到新区间外的图幅锚点失效，挑出来等重配；
    // 区间里的测点归属不变，闭合差照旧计算
    if (before && (before.startStake !== segment.startStake || before.endStake !== segment.endStake)) {
      return sketchStore.getState().markOutOfRangePending(segment)
    }
    return 0
  },
  remove: async (id) => {
    await syncDelete<Segment>(db.segments, id)
    await get().hydrate()
  },
  removeByCave: async (caveId) => {
    const ids = get()
      .segments.filter((item) => item.caveId === caveId)
      .map((item) => item.id)
    await db.segments.bulkDelete(ids)
    await get().hydrate()
  },
  bulkSetType: async (ids, type) => {
    await Promise.all(
      get()
        .segments.filter((item) => ids.includes(item.id))
        .map((item) => syncPut<Segment>(db.segments, { ...item, type }))
    )
    await get().hydrate()
  },
  bulkSetClosed: async (ids, closed) => {
    await Promise.all(
      get()
        .segments.filter((item) => ids.includes(item.id))
        .map((item) => syncPut<Segment>(db.segments, { ...item, closed }))
    )
    await get().hydrate()
  }
}))
