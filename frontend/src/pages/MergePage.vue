<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { Sketch } from '@/types'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import GridCanvas from '@/components/common/GridCanvas.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useClosureCheck } from '@/hooks/useClosureCheck'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { sketchStore } from '@/stores/sketchStore'
import { reconcileStore } from '@/stores/reconcileStore'
import { downloadCsv } from '@/utils/export'
import { stakeToNumber } from '@/utils/survey'

const CANVAS_W = 780
const CANVAS_H = 300
const SNAP_PX = 12
const PX_PER_METER = 1.6

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const sketchState = useStore(sketchStore)
const reconcileState = useStore(reconcileStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const draggingId = ref<string | null>(null)
const dragStartX = ref(0)
const dragOriginOffset = ref(0)
const snapLog = ref<string[]>([])

const offsets = reactive<Record<string, number>>({})
const snapped = reactive<Record<string, boolean>>({})

/** 待重配图幅（锚点落区间外 / 旧数据未回填）：不参与锚点吸附，等重配 */
const pendingIds = computed<Set<string>>(
  () => new Set(reconcileState.pendingSketches.map((sketch) => sketch.id))
)

const caveSegments = computed(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)

const mergeSketches = computed<Sketch[]>(() =>
  sketchState.sketches
    .filter((sketch) => caveSegments.value.some((segment) => segment.id === sketch.segmentId))
    .sort((a, b) => a.mergeOrder - b.mergeOrder)
)

/** 把图幅对齐偏移持久化到图幅自身（图幅自己存锚点与偏移） */
async function persistOffsets(ids: string[]): Promise<void> {
  const updates = ids
    .map((id) => ({ id, alignOffset: offsets[id] ?? 0 }))
    .filter((update) => {
      const sketch = sketchState.sketches.find((item) => item.id === update.id)
      return sketch && sketch.alignOffset !== update.alignOffset
    })
  if (updates.length > 0) {
    await sketchStore.getState().persistOffsets(updates)
  }
}

/** 重试重配：只处理待重配图幅，失败保住原锚点与偏移 */
async function retryReconcile(): Promise<void> {
  const { fixed, failed } = await reconcileStore.getState().retryPending()
  if (fixed > 0) ElMessage.success(`重配成功 ${fixed} 张，已归入对应洞段，锚点与偏移保留`)
  if (failed > 0) ElMessage.warning(`${failed} 张仍无洞段可归，已保住原锚点与偏移，待下次重试`)
  if (fixed === 0 && failed === 0) ElMessage.info('当前没有待重配图幅')
}

function segmentOf(sketch: Sketch): string {
  const segment = segmentState.segments.find((item) => item.id === sketch.segmentId)
  return segment ? segment.code : '未归属'
}

function widthOf(sketch: Sketch): number {
  return Math.max(88, Math.round(sketch.gridCount * (200 / Math.max(10, sketch.scale)) * 4))
}

const totalWidth = computed(() =>
  mergeSketches.value.reduce((sum, sketch) => sum + widthOf(sketch) + 10, 0)
)

// IndexedDB 异步水合完成后自动选中第一条洞穴
watch(
  () => [caveState.caves.length, selectedCaveId.value] as const,
  () => {
    if (!selectedCaveId.value && caveState.caves.length > 0) {
      selectedCaveId.value = caveState.caves[0].id
    }
  },
  { immediate: true }
)

watch(
  mergeSketches,
  (list) => {
    list.forEach((sketch) => {
      if (offsets[sketch.id] === undefined) offsets[sketch.id] = sketch.alignOffset ?? 0
      if (snapped[sketch.id] === undefined) snapped[sketch.id] = false
    })
  },
  { immediate: true }
)

/** 洞段测点闭合差（拼合视图复用闭合差徽标） */
const caveStations = computed(() =>
  stationState.stations.filter((station) =>
    caveSegments.value.some((segment) => segment.id === station.segmentId)
  )
)
const { result: closureResult } = useClosureCheck(caveStations)

/** 按桩号锚点自动吸附：以最小锚点桩号为原点，按桩号差换算横向偏移；待重配图幅不参与 */
async function autoAlign(): Promise<void> {
  const list = mergeSketches.value
  if (list.length === 0) {
    ElMessage.warning('当前洞穴暂无可拼合草图')
    return
  }
  const alignable = list.filter((sketch) => !pendingIds.value.has(sketch.id))
  if (alignable.length === 0) {
    ElMessage.warning('当前图幅均待重配，请先重试重配')
    return
  }
  const base = Math.min(...alignable.map((sketch) => stakeToNumber(sketch.anchorStake)))
  const logs: string[] = []
  alignable.forEach((sketch) => {
    const stake = stakeToNumber(sketch.anchorStake)
    const target = Math.round((stake - base) * PX_PER_METER)
    offsets[sketch.id] = target
    snapped[sketch.id] = true
    logs.push(`${sketch.code} 锚点 ${sketch.anchorStake} → 偏移 ${target}px`)
  })
  snapLog.value = logs
  await persistOffsets(alignable.map((sketch) => sketch.id))
  ElMessage.success(`已按桩号锚点吸附 ${alignable.length} 张图幅`)
}

function onMouseDown(sketch: Sketch, event: MouseEvent): void {
  draggingId.value = sketch.id
  dragStartX.value = event.clientX
  dragOriginOffset.value = offsets[sketch.id] ?? 0
}

function onMouseMove(event: MouseEvent): void {
  if (!draggingId.value) return
  const delta = event.clientX - dragStartX.value
  const raw = Math.max(-200, Math.min(CANVAS_W - 60, dragOriginOffset.value + delta))
  const list = mergeSketches.value
  const index = list.findIndex((sketch) => sketch.id === draggingId.value)
  let value = Math.round(raw)
  let snapTarget: string | null = null
  const others = list.filter((sketch) => sketch.id !== draggingId.value)
  for (const other of others) {
    const otherRight = (offsets[other.id] ?? 0) + widthOf(other)
    if (Math.abs(value - otherRight) <= SNAP_PX) {
      value = otherRight
      snapTarget = other.code
      break
    }
  }
  offsets[draggingId.value] = value
  snapped[draggingId.value] = snapTarget !== null
  if (snapTarget) {
    const current = list[index]
    snapLog.value = [`${current.code} 吸附到 ${snapTarget} 右边缘（偏移 ${value}px）`]
  }
}

function onMouseUp(): void {
  if (draggingId.value) {
    // 拖动结束把对齐偏移写回图幅自身（锚点与偏移都由图幅保存）
    persistOffsets([draggingId.value])
  }
  draggingId.value = null
}

/** 拼合顺序表（输出结果） */
interface MergeRow {
  order: number
  code: string
  segment: string
  anchorStake: string
  offset: number
  snapped: boolean
  reconcile: string
}

const mergeRows = computed<MergeRow[]>(() =>
  mergeSketches.value.map((sketch, index) => ({
    order: index + 1,
    code: sketch.code,
    segment: segmentOf(sketch),
    anchorStake: sketch.anchorStake,
    offset: offsets[sketch.id] ?? 0,
    snapped: snapped[sketch.id] ?? false,
    reconcile: pendingIds.value.has(sketch.id) ? '待重配' : '正常'
  }))
)

async function move(index: number, direction: -1 | 1): Promise<void> {
  const list = [...mergeSketches.value]
  const target = index + direction
  if (target < 0 || target >= list.length) return
  const temp = list[index]
  list[index] = list[target]
  list[target] = temp
  await sketchStore.getState().reorder(list.map((sketch) => sketch.id))
}

function exportMergeTable(): void {
  downloadCsv(
    '图幅拼合顺序表.csv',
    mergeRows.value as unknown as Record<string, unknown>[],
    [
      { key: 'order', label: '拼合顺序' },
      { key: 'code', label: '草图编号' },
      { key: 'segment', label: '洞段' },
      { key: 'anchorStake', label: '锚点桩号' },
      { key: 'offset', label: '对齐偏移(px)' },
      { key: 'snapped', label: '是否吸附' },
      { key: 'reconcile', label: '重配状态' }
    ]
  )
  ElMessage.success('拼合顺序表已导出')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">图幅拼合视图</h2>
        <p class="page-sub">
          拖动图幅可按相邻边缘吸附对齐，也可按桩号锚点一键对齐；下方输出拼合顺序表，顺序可直接调整。
        </p>
      </div>
      <div class="head-actions">
        <el-button type="primary" @click="autoAlign">按桩号锚点吸附对齐</el-button>
        <el-button @click="exportMergeTable">导出拼合顺序表</el-button>
      </div>
    </div>

    <el-alert
      v-if="reconcileState.pendingSketches.length > 0"
      type="warning"
      show-icon
      class="reconcile-banner"
      :title="`${reconcileState.pendingSketches.length} 张图幅锚点失效待重配`"
      description="桩号调整后锚点落在洞段区间外，已挑出等待重配；重配失败会保住原锚点与偏移，仅重试这些图幅，区间内测点闭合差不受影响。"
    >
      <div class="banner-actions">
        <el-button size="small" type="primary" @click="retryReconcile">重试重配</el-button>
      </div>
    </el-alert>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 220px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-tag effect="plain">图幅 {{ mergeSketches.length }} 张</el-tag>
      <el-tag effect="plain">总宽 {{ totalWidth }} px</el-tag>
      <div class="seg-tags">
        <SegmentTag
          v-for="segment in caveSegments"
          :key="segment.id"
          :type="segment.type"
          :code="segment.code"
          :closed="segment.closed"
          size="small"
        />
      </div>
    </div>

    <div class="merge-row">
      <div class="canvas-wrap" @mousemove="onMouseMove" @mouseup="onMouseUp" @mouseleave="onMouseUp">
      <GridCanvas
        :width="CANVAS_W"
        :height="CANVAS_H"
        :grid-size="20"
        :meters-per-grid="1"
        title="图幅拼合台（拖动对齐 / 锚点吸附）"
      >
        <g
          v-for="(sketch, index) in mergeSketches"
          :key="sketch.id"
          class="sheet-group"
          :class="{ 'is-pending': pendingIds.has(sketch.id) }"
          @mousedown.prevent="pendingIds.has(sketch.id) ? undefined : onMouseDown(sketch, $event)"
        >
          <rect
            :x="offsets[sketch.id] ?? 0"
            :y="40 + (index % 2) * 10"
            :width="widthOf(sketch)"
            height="96"
            rx="6"
            :fill="pendingIds.has(sketch.id) ? 'rgba(201,138,27,0.16)' : snapped[sketch.id] ? 'rgba(47,111,143,0.22)' : 'rgba(143,211,199,0.28)'"
            :stroke="pendingIds.has(sketch.id) ? '#c98a1b' : snapped[sketch.id] ? '#2f6f8f' : '#1f8a70'"
            stroke-width="1.6"
            :stroke-dasharray="pendingIds.has(sketch.id) ? '6 4' : '0'"
          />
          <text :x="(offsets[sketch.id] ?? 0) + 8" :y="62 + (index % 2) * 10" font-size="12" fill="#1f3a4d">
            {{ sketch.code }}
          </text>
          <text :x="(offsets[sketch.id] ?? 0) + 8" :y="80 + (index % 2) * 10" font-size="11" fill="#4a5b6b">
            锚点 {{ sketch.anchorStake }}
          </text>
          <text :x="(offsets[sketch.id] ?? 0) + 8" :y="96 + (index % 2) * 10" font-size="11" fill="#7a8896">
            1:{{ sketch.scale }} · {{ sketch.gridCount }} 格
          </text>
          <text
            v-if="pendingIds.has(sketch.id)"
            :x="(offsets[sketch.id] ?? 0) + 8"
            :y="112 + (index % 2) * 10"
            font-size="11"
            fill="#c98a1b"
          >
            待重配 · 锚点失效
          </text>
          <line
            v-else
            :x1="offsets[sketch.id] ?? 0"
            :y1="136 + (index % 2) * 10"
            :x2="(offsets[sketch.id] ?? 0) + 14"
            :y2="136 + (index % 2) * 10"
            stroke="#c98a1b"
            stroke-width="2"
          />
        </g>
        <text
          v-if="mergeSketches.length === 0"
          :x="CANVAS_W / 2 - 110"
          :y="CANVAS_H / 2"
          font-size="13"
          fill="#8a97a3"
        >
          该洞穴暂无草图图幅，请先到「草图工作台」建立
        </text>
        <template #legend>
          <span>拖动图幅可移动</span>
          <span>绿框 = 未吸附</span>
          <span>蓝框 = 已吸附对齐</span>
          <span>橙色短划 = 锚点桩号位置</span>
        </template>
      </GridCanvas>
      </div>

      <div class="side">
        <ClosureBadge
          :closure="closureResult.closure"
          :threshold="closureResult.threshold"
          :level="closureResult.level"
          :detail="closureResult.detail"
          :count="caveStations.length"
        />
        <el-card shadow="never" class="log-card">
          <template #header>吸附记录</template>
          <ul class="log">
            <li v-for="(line, index) in snapLog" :key="index">{{ line }}</li>
            <li v-if="snapLog.length === 0" class="muted">拖动图幅或点击「按桩号锚点吸附对齐」后显示结果</li>
          </ul>
        </el-card>
      </div>
    </div>

    <h3 class="section-title">图幅拼合顺序表</h3>
    <el-table :data="mergeRows" border stripe>
      <el-table-column prop="order" label="拼合顺序" width="100" />
      <el-table-column prop="code" label="草图编号" width="120" />
      <el-table-column prop="segment" label="洞段" width="120" />
      <el-table-column prop="anchorStake" label="桩号对齐锚点" width="150" />
      <el-table-column label="对齐偏移" width="120">
        <template #default="{ row }: { row: MergeRow }">{{ row.offset }} px</template>
      </el-table-column>
      <el-table-column label="吸附状态" width="120">
        <template #default="{ row }: { row: MergeRow }">
          <el-tag :type="row.snapped ? 'success' : 'info'" size="small" effect="plain">
            {{ row.snapped ? '已吸附' : '未吸附' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="重配状态" width="120">
        <template #default="{ row }: { row: MergeRow }">
          <el-tag :type="row.reconcile === '正常' ? 'success' : 'warning'" size="small" effect="plain">
            {{ row.reconcile }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="调整顺序" width="180">
        <template #default="{ $index }: { $index: number }">
          <el-button link type="primary" size="small" :disabled="$index === 0" @click="move($index, -1)">上移</el-button>
          <el-button
            link
            type="primary"
            size="small"
            :disabled="$index === mergeRows.length - 1"
            @click="move($index, 1)"
          >
            下移
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.seg-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.canvas-wrap {
  display: inline-flex;
}
.merge-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 320px;
}
.log-card {
  border-radius: 12px;
}
.log {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: #4a5b6b;
  line-height: 1.8;
}
.sheet-group {
  cursor: grab;
}
.sheet-group.is-pending {
  cursor: not-allowed;
}
.reconcile-banner {
  margin-bottom: 12px;
}
.banner-actions {
  margin-top: 8px;
}
</style>
