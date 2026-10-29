import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import type { PiiSealer } from '../crypto/secrets'
import { backfillReturnComments } from './return-comments'

// 退货买家备注存量加密（P6-14）：明文加密后清空；已到期的直接清；已有新密文的只清明文；幂等；日志不含内容。

const NOW = new Date('2026-10-22T08:00:00Z')
const secrets: PiiSealer = { sealBuyerPii: async text => `sealed:${text}` }

type Row = {
  id: string
  tenantId: string
  customerComments: string | null
  customerCommentsCipher: string | null
  customerCommentsExpiresAt: Date | null
  customerCommentsKinds: string | null
  returnDate: Date
  orderShippedAt: Date | null
}

const row = (over: Partial<Row> & { id: string }): Row => ({
  tenantId: 't1',
  customerComments: 'box was crushed',
  customerCommentsCipher: null,
  customerCommentsExpiresAt: null,
  customerCommentsKinds: null,
  returnDate: new Date('2026-10-10T00:00:00Z'),
  orderShippedAt: null,
  ...over,
})

function fake(rows: Row[], retentionDays?: number) {
  const fbaReturnCase = {
    findMany: async (args: { where: { id?: { gt: string } }; take: number }) =>
      rows
        .filter(item => item.customerComments !== null && (!args.where.id || item.id > args.where.id.gt))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, args.take)
        .map(item => ({ ...item })),
    updateMany: async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows.filter(item => item.id === args.where.id && (args.where.customerCommentsCipher !== null || item.customerCommentsCipher === null))
      for (const item of hit) Object.assign(item, args.data)
      return { count: hit.length }
    },
  }
  const tenantSetting = { findFirst: vi.fn().mockResolvedValue(retentionDays ? { valueJson: { customerInfoDays: retentionDays } } : null) }
  const info = vi.fn()
  const warn = vi.fn()
  return { prisma: { fbaReturnCase, tenantSetting } as unknown as PrismaClient, info, warn, logger: { info, warn } }
}

describe('退货买家备注存量加密', () => {
  it('明文加密后清空明文列；保留期按退货日（没有发货日时）加 30 天；已到期的直接清掉明文', async () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', returnDate: new Date('2026-08-01T00:00:00Z') }), row({ id: 'c', customerComments: '   ' })]
    const { prisma, logger } = fake(rows)
    const summary = await backfillReturnComments({ systemPrisma: prisma, secrets, logger, now: NOW, batchSize: 2 })
    expect(summary).toMatchObject({ scanned: 3, encrypted: 1, cleared: 2, keptNewer: 0, failed: 0 })
    expect(rows[0]).toMatchObject({ customerComments: null, customerCommentsCipher: 'sealed:box was crushed', customerCommentsKinds: '' })
    expect(rows[0].customerCommentsExpiresAt?.toISOString()).toBe('2026-11-09T00:00:00.000Z')
    for (const item of rows.slice(1)) expect(item).toMatchObject({ customerComments: null, customerCommentsCipher: null })
  })

  it('发货日与企业设置的保留天数生效；已经有新密文的行只清明文，不覆盖新密文', async () => {
    const rows = [
      row({ id: 'a', orderShippedAt: new Date('2026-10-20T00:00:00Z') }),
      row({ id: 'b', customerComments: 'old plain', customerCommentsCipher: 'sealed:newer', returnDate: new Date('2026-10-21T00:00:00Z') }),
    ]
    const { prisma, logger } = fake(rows, 5)
    const summary = await backfillReturnComments({ systemPrisma: prisma, secrets, logger, now: NOW })
    expect(summary).toMatchObject({ encrypted: 1, keptNewer: 1 })
    expect(rows[0].customerCommentsExpiresAt?.toISOString()).toBe('2026-10-25T00:00:00.000Z')
    expect(rows[1]).toMatchObject({ customerComments: null, customerCommentsCipher: 'sealed:newer' })
  })

  it('幂等：再运行一次没有任何行要处理；日志只有数量与行编号，没有备注内容', async () => {
    const rows = [row({ id: 'a', customerComments: '电话 13812345678' })]
    const { prisma, logger, info } = fake(rows)
    await backfillReturnComments({ systemPrisma: prisma, secrets, logger, now: NOW })
    const again = await backfillReturnComments({ systemPrisma: prisma, secrets, logger, now: NOW })
    expect(again.scanned).toBe(0)
    expect(JSON.stringify(info.mock.calls)).not.toContain('13812345678')
  })

  it('单行失败只计数、不中断其余行；失败行的明文保持原样等下一轮重试', async () => {
    const rows = [row({ id: 'a', customerComments: 'will fail' }), row({ id: 'b' })]
    const { prisma, logger, warn } = fake(rows)
    const flaky: PiiSealer = {
      sealBuyerPii: async text => {
        if (text === 'will fail') throw new Error('keyring down')
        return `sealed:${text}`
      },
    }
    const summary = await backfillReturnComments({ systemPrisma: prisma, secrets: flaky, logger, now: NOW })
    expect(summary).toMatchObject({ failed: 1, failedIds: ['a'], encrypted: 1 })
    expect(rows[0].customerComments).toBe('will fail')
    expect(rows[1].customerComments).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('maxBatches 限制单次处理量，剩余的下一轮继续', async () => {
    const rows = ['a', 'b', 'c'].map(id => row({ id }))
    const { prisma, logger } = fake(rows)
    const first = await backfillReturnComments({ systemPrisma: prisma, secrets, logger, now: NOW, batchSize: 1, maxBatches: 2 })
    expect(first.scanned).toBe(2)
    const second = await backfillReturnComments({ systemPrisma: prisma, secrets, logger, now: NOW, batchSize: 1, maxBatches: 2 })
    expect(second.scanned).toBe(1)
  })
})
