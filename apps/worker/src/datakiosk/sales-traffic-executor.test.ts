import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UpstreamHttpError } from '../connectors/http-error'
import type { ImportContext } from '../types'
import { runDataKioskQuery, type KioskCheckpoint, type KioskCheckpointStore } from './executor'
import { clearDataKioskDatasetsForTest, registerDataKioskDataset } from './registry'
import { salesTrafficDateDataset } from './sales-traffic'

// 销售与流量缺少品牌分析角色（P4-01）：创建查询时亚马逊回 403，执行器换成专属的不可重试失败码 DK_NO_BRAND，页面才能写清前提；
// 其他状态码与没有声明专属码的数据集保持原样（限流照常重试）。

const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const task = { dataset: 'dk.sales-traffic-by-date', params: { startDate: '2026-10-01', endDate: '2026-10-07', granularity: 'DAY' }, syncJobId: 'job-1' }
const ctx = { prisma: {} as PrismaClient, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger } as ImportContext
const store = (): KioskCheckpointStore => {
  let value: KioskCheckpoint | null = null
  return { read: () => value, write: async next => void (value = next) }
}
const http = (status: number) => new UpstreamHttpError(`SP_API_${status}`, status, new Headers(), 'api')
const kioskFailing = (error: Error) => ({ createQuery: vi.fn(async () => Promise.reject(error)), getQuery: vi.fn(), openDocument: vi.fn() })

beforeEach(() => {
  clearDataKioskDatasetsForTest()
  registerDataKioskDataset(salesTrafficDateDataset)
})

describe('销售与流量的 403', () => {
  it('创建查询被 403 拒绝：不可重试，失败码 DK_NO_BRAND，说明里写出品牌分析角色', async () => {
    const kiosk = kioskFailing(http(403))
    await expect(runDataKioskQuery(ctx, kiosk as never, scope, task, store())).rejects.toMatchObject({ code: 'DK_NO_BRAND', message: expect.stringContaining('品牌分析') })
    expect(kiosk.getQuery).not.toHaveBeenCalled()
  })

  it('限流（429）与服务端错误不改写，照常交给重试', async () => {
    for (const status of [429, 500]) {
      const error = http(status)
      await expect(runDataKioskQuery(ctx, kioskFailing(error) as never, scope, task, store())).rejects.toBe(error)
    }
  })

  it('没有声明专属失败码的数据集：403 原样抛出', async () => {
    clearDataKioskDatasetsForTest()
    registerDataKioskDataset({ ...salesTrafficDateDataset, id: 'dk.other', roleMissing: undefined })
    const error = http(403)
    await expect(runDataKioskQuery(ctx, kioskFailing(error) as never, scope, { ...task, dataset: 'dk.other' }, store())).rejects.toBe(error)
  })
})
