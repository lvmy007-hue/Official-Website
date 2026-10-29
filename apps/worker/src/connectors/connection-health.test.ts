import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UpstreamHttpError } from './http-error'

// 客户端整体替换成可控的替身：本测试只验证“调用结果 → 检查项、健康状态、错误码、落库内容”的对应关系
const calls = vi.hoisted(() => ({ participations: vi.fn(), profiles: vi.fn() }))
vi.mock('./amazon-sp-api', () => ({
  AmazonSpApiClient: class {
    getMarketplaceParticipations = calls.participations
  },
}))
vi.mock('./amazon-ads-api', () => ({
  AmazonAdsApiClient: class {
    getProfiles = calls.profiles
  },
}))

const { processConnectionHealth, usParticipation, US_MARKETPLACE_ID } = await import('./connection-health')

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger
const secrets = { open: vi.fn() } as never

function setup() {
  const created: Array<Record<string, unknown>> = []
  const updated: Array<Record<string, unknown>> = []
  const prisma = {
    connectionHealth: { create: vi.fn(async (args: { data: Record<string, unknown> }) => void created.push(args.data)) },
    platformConnection: { update: vi.fn(async (args: { data: Record<string, unknown> }) => void updated.push(args.data)) },
  } as unknown as PrismaClient
  return { prisma, created, updated }
}
const sellerRow = (token: string | null = 'sealed') => ({ tenantId: 't1', connection: { id: 'c1', provider: 'AMAZON_SP_API', encryptedRefreshToken: token, sellerAccountId: 's1' } })
const adsRow = { tenantId: 't1', connection: { id: 'c2', provider: 'AMAZON_ADS_API', encryptedRefreshToken: 'sealed', sellerAccountId: null } }
const us = (isParticipating?: boolean) => ({ payload: [{ marketplace: { id: US_MARKETPLACE_ID }, participation: isParticipating === undefined ? {} : { isParticipating } }] })

beforeEach(() => {
  calls.participations.mockReset()
  calls.profiles.mockReset()
})

describe('usParticipation', () => {
  it('有美国站且没有明确写“不参与”算参与；缺少美国站或明确不参与算没有', () => {
    expect(usParticipation(us())).toBe('YES')
    expect(usParticipation(us(true))).toBe('YES')
    expect(usParticipation(us(false))).toBe('NO')
    expect(usParticipation({ payload: [{ marketplace: { id: 'A1F83G8C2ARO7P' }, participation: { isParticipating: true } }] })).toBe('NO')
    expect(usParticipation({})).toBe('NO')
  })
})

describe('processConnectionHealth', () => {
  it('卖家接口成功且有美国站：正常，三项检查全部通过，错误码清空', async () => {
    const { prisma, created, updated } = setup()
    calls.participations.mockResolvedValue(us(true))
    const outcome = await processConnectionHealth({ prisma, logger, secrets }, sellerRow(), 'req-1')
    expect(outcome).toMatchObject({ status: 'HEALTHY', code: null })
    expect(outcome.checks.map(item => [item.key, item.ok])).toEqual([
      ['token', true],
      ['api', true],
      ['marketplace', true],
    ])
    expect(created).toEqual([expect.objectContaining({ connectionId: 'c1', status: 'HEALTHY', requestId: 'req-1' })])
    expect(updated).toEqual([expect.objectContaining({ lastErrorCode: null, lastHealthCheckedAt: expect.any(Date) })])
  })

  it('没有美国站：异常（SLR_NOT_US），前两项通过、第三项不通过', async () => {
    const { prisma, updated } = setup()
    calls.participations.mockResolvedValue(us(false))
    const outcome = await processConnectionHealth({ prisma, logger, secrets }, sellerRow(), 'req-2')
    expect(outcome).toMatchObject({ status: 'UNHEALTHY', code: 'SLR_NOT_US' })
    expect(outcome.checks.map(item => item.ok)).toEqual([true, true, false])
    expect(updated[0]).toMatchObject({ lastErrorCode: 'SLR_NOT_US' })
  })

  it('换取令牌被拒绝（lwa 400/401）：授权失效，异常；令牌项不通过、接口调用项没有进行', async () => {
    const { prisma } = setup()
    calls.participations.mockRejectedValue(new UpstreamHttpError('LWA_TOKEN_FAILED invalid_grant', 400, undefined, 'lwa'))
    const outcome = await processConnectionHealth({ prisma, logger, secrets }, sellerRow(), 'req-3')
    expect(outcome).toMatchObject({ status: 'UNHEALTHY', code: 'AUTH_EXPIRED' })
    expect(outcome.checks.map(item => [item.key, item.ok])).toEqual([
      ['token', false],
      ['api', null],
      ['marketplace', null],
    ])
  })

  it('接口返回 403（这一次调用缺角色）：受限，不是异常；令牌是好的', async () => {
    const { prisma } = setup()
    calls.participations.mockRejectedValue(new UpstreamHttpError('Forbidden', 403, undefined, 'api'))
    const outcome = await processConnectionHealth({ prisma, logger, secrets }, sellerRow(), 'req-4')
    expect(outcome).toMatchObject({ status: 'DEGRADED', code: 'ROLE_MISSING' })
    expect(outcome.checks.map(item => [item.key, item.ok])).toEqual([
      ['token', true],
      ['api', false],
      ['marketplace', null],
    ])
  })

  it('接口限流或亚马逊暂时不可用：受限；网络中断等未知错误：异常（CONNECTION_CHECK_FAILED），令牌项无法判断', async () => {
    const { prisma } = setup()
    calls.participations.mockRejectedValueOnce(new UpstreamHttpError('Too many', 429, undefined, 'api'))
    expect(await processConnectionHealth({ prisma, logger, secrets }, sellerRow(), 'r')).toMatchObject({ status: 'DEGRADED', code: 'THROTTLE_EXHAUSTED' })
    calls.participations.mockRejectedValueOnce(new UpstreamHttpError('Bad gateway', 502, undefined, 'api'))
    expect(await processConnectionHealth({ prisma, logger, secrets }, sellerRow(), 'r')).toMatchObject({ status: 'DEGRADED', code: 'UPSTREAM_ERROR' })
    calls.participations.mockRejectedValueOnce(new Error('fetch failed'))
    const outcome = await processConnectionHealth({ prisma, logger, secrets }, sellerRow(), 'r')
    expect(outcome).toMatchObject({ status: 'UNHEALTHY', code: 'CONNECTION_CHECK_FAILED' })
    expect(outcome.checks[0]).toMatchObject({ key: 'token', ok: null })
  })

  it('没有刷新令牌：不发任何请求，直接异常', async () => {
    const { prisma, created } = setup()
    const outcome = await processConnectionHealth({ prisma, logger, secrets }, sellerRow(null), 'req-6')
    expect(outcome).toMatchObject({ status: 'UNHEALTHY', code: 'REFRESH_TOKEN_NOT_CONFIGURED' })
    expect(calls.participations).not.toHaveBeenCalled()
    expect(created[0]).toMatchObject({ status: 'UNHEALTHY' })
  })

  it('广告接口：档案列表调用成功为正常；失败按同一套对应关系', async () => {
    const { prisma, created } = setup()
    calls.profiles.mockResolvedValueOnce([])
    const ok = await processConnectionHealth({ prisma, logger, secrets }, adsRow, 'req-7')
    expect(ok).toMatchObject({ status: 'HEALTHY', code: null })
    expect(ok.checks.map(item => item.key)).toEqual(['token', 'api'])
    expect(calls.participations).not.toHaveBeenCalled()
    calls.profiles.mockRejectedValueOnce(new UpstreamHttpError('Unauthorized', 401, undefined, 'api'))
    expect(await processConnectionHealth({ prisma, logger, secrets }, adsRow, 'req-8')).toMatchObject({ status: 'UNHEALTHY', code: 'AUTH_EXPIRED' })
    expect(created).toHaveLength(2)
  })
})
