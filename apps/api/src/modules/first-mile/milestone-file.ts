import { MILESTONE_ALIASES, MILESTONE_FILE_COLUMNS, MILESTONE_PRESETS } from '@nova/api-contracts'
import { parseDelimited } from '../inventory'

// 货代节点文件（importers.md F-03）的解析：纯函数。
// 列：头程单号（可选，填了就必须等于当前运单号）、节点、发生时间、地点（可选）、备注（可选）；中英文表头都认。
// 节点按别名归到常用节点（提货、离港、到港、清关完成、派送、交付），认不出的原样保留。
// 发生时间没写时区时按北京时间（UTC+8）解释；带 Z 或 ±hh:mm 的按其自带的时区。
// 一行有错整份拒绝，错误按“第 N 行”列出，最多返回前 10 条。

export interface MilestoneFileRow {
  milestone: string
  occurredAt: Date
  location: string | null
  note: string | null
}

export const MAX_MILESTONE_ROWS = 500
const MAX_ERRORS = 10

const norm = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')

const PRESET_BY_ALIAS = new Map<string, string>(MILESTONE_PRESETS.flatMap(preset => [[norm(preset), preset] as const, ...MILESTONE_ALIASES[preset].map(alias => [norm(alias), preset] as const)]))

/** 把货代的叫法归到常用节点；认不出的保留原文（去掉首尾空白）。 */
export const normalizeMilestone = (raw: string): string => PRESET_BY_ALIAS.get(norm(raw)) ?? raw.trim()

/** 解析时间：YYYY-MM-DD、YYYY-MM-DD HH:mm[:ss]、ISO；无时区按 UTC+8。解析不了返回 null。 */
export function parseOccurredAt(raw: string): Date | null {
  const text = raw.trim().replace(/\//g, '-').replace(/\./g, '-')
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(text)
  if (!match) return null
  const [, year, month, day, hour = '0', minute = '00', second = '00', zone] = match
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:${second.padStart(2, '0')}`
  const offset = zone ? (zone.toUpperCase() === 'Z' ? 'Z' : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`) : '+08:00'
  const parsed = new Date(`${iso}${offset}`)
  if (Number.isNaN(parsed.getTime())) return null
  // 防止 2026-02-31 这类被自动进位的日期
  if (!zone && new Date(parsed.getTime() + 8 * 3_600_000).toISOString().slice(0, 10) !== `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`) return null
  return parsed
}

export function parseMilestoneFile(content: string, waybillNo: string, now: Date = new Date()): { rows: MilestoneFileRow[]; errors: string[] } {
  const table = parseDelimited(content)
  const errors: string[] = []
  const fail = (message: string) => {
    if (errors.length < MAX_ERRORS) errors.push(message)
  }
  if (table.length < 2) return { rows: [], errors: ['文件里没有数据行（第一行应是表头：头程单号、节点、发生时间、地点、备注）'] }
  const header = table[0].map(norm)
  const indexOf = (aliases: readonly string[]) => header.findIndex(name => aliases.some(alias => norm(alias) === name))
  const columns = {
    waybill: indexOf(MILESTONE_FILE_COLUMNS.waybill),
    milestone: indexOf(MILESTONE_FILE_COLUMNS.milestone),
    at: indexOf(MILESTONE_FILE_COLUMNS.occurredAt),
    location: indexOf(MILESTONE_FILE_COLUMNS.location),
    note: indexOf(MILESTONE_FILE_COLUMNS.note),
  }
  if (columns.milestone < 0 || columns.at < 0) return { rows: [], errors: ['表头缺少必需的列：节点、发生时间（可选列：头程单号、地点、备注）'] }
  if (table.length - 1 > MAX_MILESTONE_ROWS) return { rows: [], errors: [`数据行过多（最多 ${MAX_MILESTONE_ROWS} 行）`] }
  const rows: MilestoneFileRow[] = []
  const seen = new Set<string>()
  const latest = now.getTime() + 86_400_000
  table.slice(1).forEach((cells, offset) => {
    const line = offset + 2
    const cell = (index: number) => (index >= 0 ? (cells[index] ?? '').trim() : '')
    if (columns.waybill >= 0 && cell(columns.waybill) !== '' && cell(columns.waybill) !== waybillNo) {
      return fail(`第 ${line} 行：头程单号“${cell(columns.waybill)}”与当前运单号“${waybillNo}”不一致`)
    }
    const milestone = normalizeMilestone(cell(columns.milestone))
    if (!milestone) return fail(`第 ${line} 行：节点为空`)
    if (milestone.length > 40) return fail(`第 ${line} 行：节点过长（最多 40 个字符）`)
    const occurredAt = parseOccurredAt(cell(columns.at))
    if (!occurredAt) return fail(`第 ${line} 行：发生时间“${cell(columns.at)}”格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm`)
    if (occurredAt.getTime() > latest) return fail(`第 ${line} 行：发生时间不能晚于今天`)
    const key = `${milestone}|${occurredAt.toISOString()}`
    if (seen.has(key)) return fail(`第 ${line} 行：同一节点同一时间出现了多次`)
    seen.add(key)
    rows.push({ milestone, occurredAt, location: cell(columns.location).slice(0, 80) || null, note: cell(columns.note).slice(0, 300) || null })
  })
  return { rows: errors.length ? [] : rows, errors }
}
