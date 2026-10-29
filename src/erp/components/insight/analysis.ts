// 分析类展示组件背后的纯计算（03 章 3.4 第 2、4、5、9 项）。
// 全部是纯函数、不访问接口：输入来自页面取到的真实数据，输出只用于展示。

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

// ---- 前后对照（第 4 项）----
export type BeforeAfterInput = {
  before: readonly number[]
  after: readonly number[]
  /** 同期大盘（参照）：避免把整体波动误判为操作效果。 */
  benchBefore?: readonly number[]
  benchAfter?: readonly number[]
}

export type BeforeAfterResult = {
  beforeTotal: number
  afterTotal: number
  /** 变化比率；前期为 0 时无法计算，返回 null。 */
  change: number | null
  benchChange: number | null
  /** 扣除大盘变化后的净变化（百分点）；任一方缺失为 null。 */
  adjusted: number | null
  days: { before: number; after: number }
}

const ratioChange = (before: number, after: number) => (before === 0 ? null : after / before - 1)

export function compareBeforeAfter(input: BeforeAfterInput): BeforeAfterResult {
  const beforeTotal = sum(input.before)
  const afterTotal = sum(input.after)
  const change = ratioChange(beforeTotal, afterTotal)
  const benchChange = input.benchBefore && input.benchAfter ? ratioChange(sum(input.benchBefore), sum(input.benchAfter)) : null
  return {
    beforeTotal,
    afterTotal,
    change,
    benchChange,
    adjusted: change !== null && benchChange !== null ? change - benchChange : null,
    days: { before: input.before.length, after: input.after.length },
  }
}

// ---- 指标树归因（第 5 项）----
// 乘积型指标（销售额 = 会话 × 转化率 × 件单价）用对数平均分解：各因子贡献之和恰好等于指标总变化。
export type Factor = { key: string; label: string; before: number; after: number }
export type Contribution = { key: string; label: string; contribution: number; /** 占总变化的比例（总变化为 0 时为 null）。 */ share: number | null }

export function decomposeProduct(factors: readonly Factor[]): { total: number; contributions: Contribution[] } | null {
  if (factors.length === 0 || factors.some(f => !(f.before > 0) || !(f.after > 0))) return null
  const v0 = factors.reduce((p, f) => p * f.before, 1)
  const v1 = factors.reduce((p, f) => p * f.after, 1)
  const total = v1 - v0
  const logMean = v1 === v0 ? v0 : total / (Math.log(v1) - Math.log(v0))
  const contributions = factors
    .map(f => {
      const contribution = logMean * Math.log(f.after / f.before)
      return { key: f.key, label: f.label, contribution, share: total === 0 ? null : contribution / total }
    })
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
  return { total, contributions }
}

/** 加法型指标（利润桥：利润 = 收入 − 各项成本）：每项的变化直接就是贡献，按绝对值排序。 */
export type BridgeItem = { key: string; label: string; before: number; after: number; /** 成本类项目：增加会拉低利润。 */ cost?: boolean }

export function decomposeBridge(items: readonly BridgeItem[]): { total: number; contributions: Contribution[] } {
  const rows = items.map(item => ({ key: item.key, label: item.label, contribution: (item.after - item.before) * (item.cost ? -1 : 1) }))
  const total = sum(rows.map(row => row.contribution))
  const contributions = rows.map(row => ({ ...row, share: total === 0 ? null : row.contribution / total })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
  return { total, contributions }
}

// ---- 双源核对（第 2 项）----
export type DualSourceResult = { diff: number; diffRatio: number | null; flagged: boolean }

export function evaluateDualSource(ours: number, official: number, thresholdRatio: number): DualSourceResult {
  const diff = ours - official
  const diffRatio = official === 0 ? (ours === 0 ? 0 : null) : diff / Math.abs(official)
  // 官方值为 0 而我方不为 0，无法算比率，视为需要关注
  const flagged = diffRatio === null ? true : Math.abs(diffRatio) > thresholdRatio
  return { diff, diffRatio, flagged }
}

// ---- 历史快照对比（第 9 项）----
export type SnapshotChange = { key: string; label: string; before: string; after: string }

const show = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '（空）'
  if (Array.isArray(value)) return value.length ? value.map(item => String(item)).join('、') : '（空）'
  return String(value)
}

/** 只比较有中文名称的字段，面向业务用户展示；没有名称的内部字段不展示。 */
export function diffSnapshots(before: Record<string, unknown>, after: Record<string, unknown>, labels: Readonly<Record<string, string>>): SnapshotChange[] {
  const changes: SnapshotChange[] = []
  for (const [key, label] of Object.entries(labels)) {
    if (show(before[key]) !== show(after[key])) changes.push({ key, label, before: show(before[key]), after: show(after[key]) })
  }
  return changes
}
