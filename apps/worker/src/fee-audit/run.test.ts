import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { auditAllTenants, auditTenant, FEE_AUDIT_INTERVAL_MS } from './run'

// 费用核查任务的容错（P2b-06）：单类核查出错不拖垮其它类，出错的那一类不清理旧结果；单个企业出错不拖垮其它企业。
// 四类核查的数值结论在真实数据库测试（apps/api/src/testing/fee-audit.db.test.ts）里验证。

const NOW = new Date('2026-10-23T08:00:00Z')

function fakeDb(failing: string[] = []) {
  const feeAudit = { upsert: vi.fn(), deleteMany: vi.fn(async (_args: { where: Record<string, unknown> }) => ({ count: 0 })) }
  const models = new Map<string, unknown>([['feeAudit', feeAudit]])
  const db = new Proxy(
    {},
    {
      get(_target, model: string) {
        if (!models.has(model)) {
          models.set(
            model,
            new Proxy(
              {},
              {
                get: (_inner, op: string) => async () => {
                  if (failing.includes(model)) throw new Error(`${model} 读取失败`)
                  return op === 'deleteMany' ? { count: 0 } : []
                },
              },
            ),
          )
        }
        return models.get(model)
      },
    },
  ) as unknown as PrismaClient
  return { db, feeAudit }
}

describe('auditTenant', () => {
  it('没有数据：四类各产出 0 个对象，没有错误', async () => {
    const { db } = fakeDb()
    const result = await auditTenant(db, 't1', NOW)
    expect(result.errors).toEqual([])
    expect(result.results.map(item => [item.kind, item.subjects])).toEqual([
      ['FULFILLMENT', 0],
      ['COMMISSION', 0],
      ['STORAGE', 0],
      ['INBOUND_PLACEMENT', 0],
    ])
    expect(result.written).toBe(0)
  })

  it('费用事件读取失败：配送费、佣金、入仓配置费各记一个错误，仓储费照常完成；出错的类不清理旧结果', async () => {
    const { db, feeAudit } = fakeDb(['fbaFeeEvent'])
    const result = await auditTenant(db, 't1', NOW)
    expect(result.errors.map(item => item.split(':')[0])).toEqual(['fulfillment', 'commission', 'placement'])
    expect(result.errors[0]).toContain('fbaFeeEvent 读取失败')
    expect(result.results.map(item => item.kind)).toEqual(['STORAGE'])
    const cleaned = feeAudit.deleteMany.mock.calls.map(call => (call[0].where as { feeKind?: string }).feeKind).filter(Boolean)
    expect(cleaned).toEqual(['STORAGE'])
  })

  it('写入失败：记为 write 错误，不抛出', async () => {
    const { db, feeAudit } = fakeDb()
    feeAudit.deleteMany.mockRejectedValue(new Error('写入失败'))
    const result = await auditTenant(db, 't1', NOW)
    expect(result.errors).toEqual(['write: 写入失败'])
  })
})

describe('auditAllTenants', () => {
  it('只处理试用与正常状态的企业，逐个运行并累计写入数；核查内部的错误只记警告', async () => {
    const warn = vi.fn()
    const { db } = fakeDb(['fbaFeeEvent'])
    const systemDb = { tenant: { findMany: vi.fn(async () => [{ id: 'a' }, { id: 'b' }]) } } as unknown as Pick<PrismaClient, 'tenant'>
    const result = await auditAllTenants({ systemDb, db, logger: { info: vi.fn(), warn }, now: () => NOW })
    expect(result).toEqual({ tenants: 2, written: 0 })
    expect(systemDb.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } } }))
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toMatchObject({ event: 'fee_audit_errors' })
  })

  it('间隔为 6 小时', () => {
    expect(FEE_AUDIT_INTERVAL_MS).toBe(21_600_000)
  })
})
