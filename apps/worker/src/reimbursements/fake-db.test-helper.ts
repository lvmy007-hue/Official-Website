import type { PrismaClient } from '@prisma/client'

// 赔付中心扫描测试的内存数据库替身（仅测试使用）：支持 equal / in / not / gt / gte / lt / lte / contains / AND / OR，
// 以及 findMany、findFirst、findUnique、create、upsert、updateMany；复合唯一键（a_b_c: {...}）展开成各列。

// 测试里按需读行的字段，用宽松类型（与 fake-context 同一做法，lint 警告上限为 35）
type Loose = ReturnType<typeof JSON.parse>
export type Row = Record<string, Loose>

export const dec = (value: number) => ({ toNumber: () => value, valueOf: () => value, toString: () => String(value) })

const same = (a: Loose, b: Loose) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b)

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (value as Row[]).every(item => matches(row, item))
    if (key === 'OR') return (value as Row[]).some(item => matches(row, item))
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const cell = row[key]
      return Object.entries(value as Row).every(([op, arg]) => {
        switch (op) {
          case 'in':
            return (arg as Loose[]).some(item => same(item, cell))
          case 'not':
            return arg === null ? cell !== null && cell !== undefined : !same(cell, arg)
          case 'gt':
            return cell > arg
          case 'gte':
            return cell >= arg
          case 'lt':
            return cell < arg
          case 'lte':
            return cell <= arg
          case 'contains':
            return String(cell ?? '')
              .toLowerCase()
              .includes(String(arg).toLowerCase())
          default:
            return true
        }
      })
    }
    return same(row[key], value)
  })
}

const flatten = (where: Row): Row =>
  Object.fromEntries(
    Object.entries(where).flatMap(([key, value]) =>
      key.includes('_') && value && typeof value === 'object' && !(value instanceof Date) && !('in' in value) ? Object.entries(value as Row) : [[key, value]],
    ),
  )

export function table(rows: Row[] = [], defaults: Row = {}) {
  let seq = rows.length
  const find = (where?: Row) => rows.find(row => matches(row, where ? flatten(where) : undefined))
  const apply = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in (value as Row)) row[key] = (row[key] ?? 0) + (value as Row).increment
      else row[key] = value
    }
  }
  return {
    rows,
    findMany: async (args: Row = {}) => {
      const hit = rows.filter(row => matches(row, args.where))
      return typeof args.take === 'number' ? hit.slice(0, args.take) : hit
    },
    findFirst: async (args: Row = {}) => find(args.where) ?? null,
    findUnique: async (args: Row) => find(args.where) ?? null,
    count: async (args: Row = {}) => rows.filter(row => matches(row, args.where)).length,
    create: async (args: Row) => {
      const row = { id: `r${(seq += 1)}`, ...defaults, ...args.data }
      rows.push(row)
      return row
    },
    upsert: async (args: Row) => {
      const found = find(args.where)
      if (found) apply(found, args.update)
      else rows.push({ id: `r${(seq += 1)}`, ...defaults, ...args.create })
      return found ?? rows[rows.length - 1]
    },
    updateMany: async (args: Row) => {
      const hit = rows.filter(row => matches(row, args.where))
      for (const row of hit) apply(row, args.data)
      return { count: hit.length }
    },
  }
}

export type Tables = Record<string, Row[]>

/** 按表名装配一个只有这些表的库；没给的表是空表。 */
export function fakeDb(data: Tables = {}) {
  const names = [
    'reimbursementOpportunity',
    'reimbursementRecord',
    'reimbursementCase',
    'costVersion',
    'tenantSetting',
    'inventoryLedgerEntry',
    'fbaReturnCase',
    'fbaFinancialTransaction',
    'orderItem',
    'removalOrder',
    'receivingDiscrepancy',
    'fbaInboundShipment',
    'fbaInboundPlan',
    'entityEvent',
  ]
  const tables = Object.fromEntries(names.map(name => [name, table(data[name] ?? [], name === 'reimbursementOpportunity' ? { status: 'PENDING', version: 1 } : {})]))
  return { db: tables as unknown as PrismaClient, tables }
}

export const DAY_MS = 86_400_000
export const NOW = new Date('2026-10-23T08:00:00Z')
/** 距离“现在”若干天前的当天零点（UTC）。 */
export const daysAgo = (days: number) => new Date(Date.UTC(2026, 9, 23) - days * DAY_MS)
export const dayText = (date: Date) => date.toISOString().slice(0, 10)
