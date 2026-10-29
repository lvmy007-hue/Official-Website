import type { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { archiveUnseen } from './archive'
import type { Scope } from './tables'

// 归档（P5-12A）：用内存假库验证三道保护与“只改本表本租户的行”。真实库里的整条链路在 ads-sync.db.test.ts。

const scope: Scope = { tenantId: 't1', adsProfileId: 'p1', adsAccountId: 'acc1', currency: 'USD', now: new Date('2026-10-30T00:00:00Z') }

function fakeDb(rows: Array<{ id: string; adGroupId: string; state: string }>) {
  const calls: Array<{ op: string; where: Record<string, unknown>; data?: Record<string, unknown> }> = []
  const delegate = {
    count: async () => rows.filter(row => row.state !== 'ARCHIVED').length,
    findMany: async () => rows.filter(row => row.state !== 'ARCHIVED'),
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      calls.push({ op: 'updateMany', ...args })
      const ids = (args.where.id as { in: string[] }).in
      for (const row of rows) if (ids.includes(row.id)) row.state = String(args.data.state)
    },
    deleteMany: async (args: { where: Record<string, unknown> }) => calls.push({ op: 'deleteMany', ...args }),
  }
  return { db: { adsAdGroup: delegate, adsNegativeTarget: delegate } as unknown as PrismaClient, calls, rows }
}
const rowsOf = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `r${index}`, adGroupId: `G${index}`, state: 'ENABLED' }))

describe('archiveUnseen', () => {
  it('翻页没翻完：不碰任何行，原因是 INCOMPLETE', async () => {
    const { db, calls } = fakeDb(rowsOf(3))
    expect(await archiveUnseen(db, 'adGroups', scope, new Set(['G0']), false)).toEqual({ archived: 0, skipped: 'INCOMPLETE' })
    expect(calls).toEqual([])
  })

  it('读完且没出现的归档：只改状态，条件带租户', async () => {
    const { db, calls, rows } = fakeDb(rowsOf(3))
    expect(await archiveUnseen(db, 'adGroups', scope, new Set(['G0', 'G1']), true)).toEqual({ archived: 1, skipped: null })
    expect(rows.map(row => row.state)).toEqual(['ENABLED', 'ENABLED', 'ARCHIVED'])
    expect(calls).toHaveLength(1)
    expect(calls[0].where).toMatchObject({ tenantId: 't1', id: { in: ['r2'] } })
    expect(calls[0].data).toMatchObject({ state: 'ARCHIVED', sourceUpdatedAt: scope.now })
  })

  it('一条都没读到：当作接口返回为空，不归档', async () => {
    const { db, calls } = fakeDb(rowsOf(3))
    expect(await archiveUnseen(db, 'adGroups', scope, new Set(), true)).toEqual({ archived: 0, skipped: 'EMPTY_RESPONSE' })
    expect(calls).toEqual([])
  })

  it('一次要归档过半（至少 20 行）：不归档', async () => {
    const { db, calls } = fakeDb(rowsOf(30))
    const seen = new Set(rowsOf(5).map(row => row.adGroupId))
    expect(await archiveUnseen(db, 'adGroups', scope, seen, true)).toEqual({ archived: 0, skipped: 'TOO_MANY' })
    expect(calls).toEqual([])
  })

  it('读到但没能映射的对象只登记了亚马逊编号：不当作“没出现”', async () => {
    const { db, rows } = fakeDb(rowsOf(2))
    expect(await archiveUnseen(db, 'adGroups', scope, new Set(['G0', 'G1']), true)).toEqual({ archived: 0, skipped: null })
    expect(rows.every(row => row.state === 'ENABLED')).toBe(true)
  })

  it('没有状态列的否定投放：归档就是删除本地副本', async () => {
    const { db, calls } = fakeDb([
      { id: 'n1', adGroupId: 'x', state: 'ENABLED' },
      { id: 'n2', adGroupId: 'y', state: 'ENABLED' },
    ])
    const target = (db as unknown as { adsNegativeTarget: { findMany: () => Promise<Array<Record<string, unknown>>> } }).adsNegativeTarget
    const original = target.findMany
    target.findMany = async () => (await original()).map(row => ({ ...row, negativeId: row.id === 'n1' ? 'N1' : 'N2' }))
    expect(await archiveUnseen(db, 'negatives', scope, new Set(['N1']), true)).toEqual({ archived: 1, skipped: null })
    expect(calls).toEqual([{ op: 'deleteMany', where: { tenantId: 't1', id: { in: ['n2'] } } }])
  })
})
