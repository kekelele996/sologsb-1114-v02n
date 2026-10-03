/** 图幅锚点重配状态 */
export type ReconcileStatus = 'ok' | 'pending' | 'failed'

/** Sketch 草图 */
export interface Sketch {
  id: string
  /** 所属区间（洞段）id；旧数据可能为空，升级时按锚点回填 */
  segmentId: string
  /** 草图编号 */
  code: string
  /** 坐标纸格数 */
  gridCount: number
  /** 缩放比例（1:N 的 N，如 200 表示 1:200） */
  scale: number
  /** 绘制人 */
  author: string
  /** 图幅拼合顺序号 */
  mergeOrder: number
  /** 桩号对齐锚点 */
  anchorStake: string
  /** 拼合对齐偏移（图幅自己存，单位：拼合台 px） */
  alignOffset: number
  /** 图片数据说明 */
  imageNote: string
  /** 锚点重配状态：ok 正常 / pending 待重配 / failed 重配失败待重试 */
  reconcileStatus: ReconcileStatus
  /** 最近一次重配 / 回填的说明（失败原因等） */
  reconcileReason?: string
}

/** 图幅拼合对齐结果 */
export interface MergeItem {
  sketchId: string
  /** 对齐后的横向偏移（单位：格） */
  offset: number
  /** 是否已吸附到锚点 */
  snapped: boolean
}
