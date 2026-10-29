// 从冻结的指标口径字典 docs/erp-plan/freeze/metrics.md 生成 packages/api-contracts/src/metric-definitions.generated.ts。
// 口径以字典为准：改字典后重新运行本脚本，持续集成用 --check 校验两者一致（P1-28-8）。
//   node scripts/gen-metric-definitions.mjs          生成
//   node scripts/gen-metric-definitions.mjs --check  只校验，不一致则退出码为 1
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'docs/erp-plan/freeze/metrics.md')
const target = join(root, 'packages/api-contracts/src/metric-definitions.generated.ts')

const TYPES = ['官方', '我方计算', '模型估算', '导入', '无官方来源']
const lines = readFileSync(source, 'utf8').split(/\r?\n/)

// 单元格里可能出现被转义的竖线（\|），先保护起来再切分
const splitRow = line =>
  line
    .replace(/\\\|/g, '\u0000')
    .split('|')
    .slice(1, -1)
    .map(cell => cell.split('\u0000').join('|').trim())

const clean = text => text.replace(/`/g, '').replace(/\*\*/g, '')
const items = []
let group = ''
let previous = null
for (const line of lines) {
  const heading = /^## [一二三四五六七八九十]+、(.+?)（.*?章.*?）$/.exec(line)
  if (heading) group = heading[1]
  else if (line.startsWith('## ')) group = ''
  if (!group || !/^\| M-\d+ /.test(line)) continue
  const cols = splitRow(line)
  if (cols.length !== 8) throw new Error(`指标表列数不对：${line}`)
  const [id, name, rawType, definition, origin, refresh, version, pages] = cols
  // 竞品评分（M-342）明确无官方来源、不设指标：类型、来源、刷新、版本均为“—”
  const type = rawType === '—' ? '无官方来源' : rawType
  if (!TYPES.includes(type)) throw new Error(`无法识别的指标类型：${type}（${id}）`)
  const versionMatch = version === '—' ? null : /^@(\d+)$/.exec(version)
  if (version !== '—' && !versionMatch) throw new Error(`无法识别的口径版本：${version}（${id}）`)
  // “同上”表示与上一行相同
  const inherit = (value, key) => (value === '同上' && previous ? previous[key] : value)
  const item = {
    id,
    name: clean(name),
    type,
    group,
    definition: clean(definition),
    source: clean(inherit(origin, 'source')),
    refresh: clean(inherit(refresh, 'refresh')),
    version: versionMatch ? Number(versionMatch[1]) : null,
    pages: clean(inherit(pages, 'pagesText'))
      .split(/[、，]/)
      .map(page => page.trim())
      .filter(Boolean),
    pagesText: clean(inherit(pages, 'pagesText')),
  }
  items.push(item)
  previous = item
}

// ---- 三个新字段（P6-03）：补充表 reconcileWith / mismatchReasons / configurableAt，按指标编号合并进主表 ----
const routeSet = new Set()
for (const line of readFileSync(join(root, 'docs/erp-plan/freeze/routes.md'), 'utf8').split(/\r?\n/)) {
  const match = /^\| `(\/[^`]+)` \|/.exec(line)
  if (match) routeSet.add(match[1])
}
if (routeSet.size < 100) throw new Error(`routes.md 里只读到 ${routeSet.size} 条路由，格式可能变了`)

const LINK_PATTERN = /^(.+?)（`([^`]+)`）$/
const parseLinks = (cell, id, field) => {
  if (cell === '无' || cell === '' || cell === '—') return []
  return cell.split('、').map(part => {
    const match = LINK_PATTERN.exec(part.trim())
    if (!match) throw new Error(`${id} 的 ${field} 写法不对（要写成 标签（\`路由\`））：${part}`)
    const [, label, route] = match
    if (!routeSet.has(route)) throw new Error(`${id} 的 ${field} 引用了 routes.md 里没有的路由：${route}`)
    return { label: label.trim(), route }
  })
}
const supplements = new Map()
const coreIds = new Set()
let supplementTable = false
for (const line of lines) {
  const core = /^核心指标清单：(.+)$/.exec(line)
  if (core) for (const id of core[1].split('、')) coreIds.add(id.trim())
  if (/^\| 编号 \| 指标 \| reconcileWith \| mismatchReasons \| configurableAt \|$/.test(line)) {
    supplementTable = true
    continue
  }
  if (supplementTable && !line.startsWith('|')) supplementTable = false
  if (!supplementTable || !/^\| M-\d+ /.test(line)) continue
  const cols = splitRow(line)
  if (cols.length !== 5) throw new Error(`补充表列数不对：${line}`)
  const [id, , reconcile, reasons, configurable] = cols
  if (supplements.has(id)) throw new Error(`补充表里 ${id} 出现了两次`)
  supplements.set(id, { reconcile, reasons, configurable })
}

const byId = new Map(items.map(item => [item.id, item]))
for (const [id, raw] of supplements) {
  const target = byId.get(id)
  if (!target) {
    // 阶段 6 新指标（M-7xx）还没并入主表：不进字典，只核对引用的路由真实存在
    for (const route of [...`${raw.reconcile}${raw.configurable}`.matchAll(/`(\/[^`]+)`/g)].map(match => match[1])) {
      if (!routeSet.has(route)) throw new Error(`${id} 引用了 routes.md 里没有的路由：${route}`)
    }
    continue
  }
  target.reconcileWith = parseLinks(raw.reconcile, id, 'reconcileWith')
  target.mismatchReasons =
    raw.reasons === '无'
      ? []
      : raw.reasons
          .split('；')
          .map(text => text.trim())
          .filter(Boolean)
  const configurable = parseLinks(raw.configurable, id, 'configurableAt')
  if (configurable.length > 1) throw new Error(`${id} 的 configurableAt 只能有一个位置`)
  target.configurableAt = configurable[0] ?? null
  if (target.reconcileWith.length > 0 && target.mismatchReasons.length === 0) throw new Error(`${id} 有对数页面就至少要写一条可能对不上的原因`)
}
for (const id of coreIds) {
  const target = byId.get(id)
  if (!target) throw new Error(`核心指标 ${id} 不在字典里`)
  if (!target.reconcileWith?.length || !target.mismatchReasons?.length) throw new Error(`核心指标 ${id} 必须同时有 reconcileWith 与 mismatchReasons`)
}
if (coreIds.size === 0) throw new Error('metrics.md 里没有“核心指标清单”')
// ---- 可用于规则的指标（P6-07，metrics.md 10.8）：按编号合并成 ruleUse，没有登记的是 null ----
const RULE_DOMAINS = { 销售: 'sales', 广告: 'ads', 库存: 'inventory', 利润: 'profit', 售后: 'aftersales' }
const RULE_UNITS = { 金额: 'money', 百分比: 'percent', 件数: 'count', 天数: 'days', 倍数: 'ratio' }
const RULE_AGGS = { 合计: 'sum', 平均值: 'avg', 最新值: 'last', 最小值: 'min', 最大值: 'max' }
const ruleUse = new Map()
let ruleTable = false
for (const line of lines) {
  if (line === '| 编号 | 指标 | 规则域 | 数值单位 | 聚合方式 |') {
    ruleTable = true
    continue
  }
  if (ruleTable && !line.startsWith('|')) ruleTable = false
  if (!ruleTable || !/^\| M-\d+ /.test(line)) continue
  const cols = splitRow(line)
  if (cols.length !== 5) throw new Error(`规则指标表列数不对：${line}`)
  const [id, , domain, unit, aggText] = cols
  if (ruleUse.has(id)) throw new Error(`规则指标表里 ${id} 出现了两次`)
  if (!byId.has(id)) throw new Error(`规则指标 ${id} 不在字典里`)
  if (!RULE_DOMAINS[domain]) throw new Error(`${id} 的规则域不认识：${domain}`)
  if (!RULE_UNITS[unit]) throw new Error(`${id} 的数值单位不认识：${unit}`)
  const aggs = aggText.split('、').map(text => RULE_AGGS[text.trim()])
  if (aggs.length === 0 || aggs.some(agg => !agg) || new Set(aggs).size !== aggs.length) throw new Error(`${id} 的聚合方式写法不对：${aggText}`)
  // 比率、天数、倍数、存量类不能合计（把比率加起来没有意义）
  if (aggs.includes('sum') && ['percent', 'days', 'ratio'].includes(RULE_UNITS[unit])) throw new Error(`${id} 是${unit}类，不能合计`)
  if (RULE_DOMAINS[domain] === 'inventory' && aggs.includes('sum')) throw new Error(`${id} 是库存存量，不能合计`)
  ruleUse.set(id, { domain: RULE_DOMAINS[domain], unit: RULE_UNITS[unit], aggs })
}
if (ruleUse.size === 0) throw new Error('metrics.md 里没有 10.8“可用于规则条件的指标”')
for (const domain of Object.values(RULE_DOMAINS)) {
  if (![...ruleUse.values()].some(use => use.domain === domain)) throw new Error(`规则域 ${domain} 一个指标也没有登记`)
}
for (const [id, use] of ruleUse) byId.get(id).ruleUse = use

for (const item of items) {
  item.ruleUse ??= null
  item.reconcileWith ??= []
  item.mismatchReasons ??= []
  item.configurableAt ??= null
}

if (items.length !== 217) throw new Error(`指标数量应为 217，实际 ${items.length}`)
if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('指标编号有重复')
if (new Set(items.map(item => item.name)).size !== items.length) {
  const seen = new Set()
  const dup = items.filter(item => (seen.has(item.name) ? true : (seen.add(item.name), false))).map(item => item.name)
  throw new Error(`同名指标只能有一个口径，重复名称：${dup.join('、')}`)
}

const body = items.map(({ pagesText: _pagesText, ...item }) => `  ${JSON.stringify(item)},`).join('\n')
const output = `// 本文件由 scripts/gen-metric-definitions.mjs 从 docs/erp-plan/freeze/metrics.md 生成，请勿手工修改。
import type { MetricDefinition } from './metrics-catalog.js'

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
${body}
]
`

const current = existsSync(target) ? readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : ''
if (process.argv.includes('--check')) {
  if (current !== output) {
    console.error('packages/api-contracts/src/metric-definitions.generated.ts 与 metrics.md 不一致，请运行 node scripts/gen-metric-definitions.mjs')
    process.exit(1)
  }
  console.log(`指标口径与 metrics.md 一致（${items.length} 条）`)
} else {
  writeFileSync(target, output)
  console.log(`已生成 ${target}（${items.length} 条）`)
}
