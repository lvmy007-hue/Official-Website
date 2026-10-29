import { describe, expect, it, vi } from 'vitest'
import { purgeExpiredRawFiles } from './raw-file-retention'

type Row = { id: string; objectKey: string; retentionUntil: Date }

function setup(rows: Row[], failingKeys: string[] = []) {
  const table = [...rows]
  const systemPrisma = {
    rawReportFile: {
      findMany: vi.fn(async (args: { where: { retentionUntil: { lte: Date }; id?: { notIn: string[] } }; take: number }) =>
        table.filter(row => row.retentionUntil <= args.where.retentionUntil.lte && !(args.where.id?.notIn ?? []).includes(row.id)).slice(0, args.take),
      ),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        table.splice(
          table.findIndex(row => row.id === args.where.id),
          1,
        )
      }),
    },
  }
  const deleted: string[] = []
  const storage = {
    delete: vi.fn(async (key: string) => {
      if (failingKeys.includes(key)) throw new Error('存储不可用')
      deleted.push(key)
    }),
  }
  const logger = { info: vi.fn(), warn: vi.fn() }
  return { table, systemPrisma, storage, logger, deleted }
}

describe('原始文件到期清理', () => {
  const now = new Date('2026-10-01T00:00:00Z')
  const row = (id: string, day: string): Row => ({ id, objectKey: `tenants/t1/reports/2026/01/01/${id}`, retentionUntil: new Date(day) })

  it('只清理已到期的：先删文件、再删登记', async () => {
    const ctx = setup([row('a', '2026-09-01'), row('b', '2026-12-01'), row('c', '2026-10-01')])
    const result = await purgeExpiredRawFiles({ ...ctx, systemPrisma: ctx.systemPrisma as never, now: () => now })
    expect(result).toEqual({ deleted: 2, failed: 0 })
    expect(ctx.deleted.sort()).toEqual(['tenants/t1/reports/2026/01/01/a', 'tenants/t1/reports/2026/01/01/c'])
    expect(ctx.table.map(item => item.id)).toEqual(['b'])
  })

  it('删文件失败：登记保留（下次再试），不影响其他文件，日志只给数量', async () => {
    const ctx = setup([row('a', '2026-09-01'), row('b', '2026-09-02')], ['tenants/t1/reports/2026/01/01/a'])
    const result = await purgeExpiredRawFiles({ ...ctx, systemPrisma: ctx.systemPrisma as never, now: () => now })
    expect(result).toEqual({ deleted: 1, failed: 1 })
    expect(ctx.table.map(item => item.id)).toEqual(['a'])
    expect(ctx.logger.warn).toHaveBeenCalledWith({ event: 'raw_files_purge_failed', failed: 1 }, expect.any(String))
    expect(JSON.stringify(ctx.logger.info.mock.calls)).not.toContain('tenants/')
  })

  it('一次运行分多批处理完大量到期文件', async () => {
    const many = Array.from({ length: 450 }, (_, index) => row(`f${index}`, '2026-09-01'))
    const ctx = setup(many)
    const result = await purgeExpiredRawFiles({ ...ctx, systemPrisma: ctx.systemPrisma as never, now: () => now })
    expect(result.deleted).toBe(450)
    expect(ctx.table).toHaveLength(0)
  })
})
