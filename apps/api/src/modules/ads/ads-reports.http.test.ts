import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 广告报表与广告指标接口（P3-15）：未登录、权限先于参数校验、参数校验、写入口的权限与请求体校验。
// 任务创建与重试、回补、核对触发、指标汇总、数据范围、企业隔离的真实行为见 testing/ads-reports.db.test.ts（真实数据库）。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const prismaFor = (permissions: string[]) => ({
  ...sessionStub(permissions),
  sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '店铺 s1' }]) },
  tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
})

const READS = ['/ads/reports', '/ads/report-templates', '/ads/parity', '/ads/parity/run-1/diffs', '/ads/metrics']
const WRITES: Array<[string, unknown]> = [
  ['/ads/reports', { profileId: 'p-1', templateKey: 'CAMPAIGN_DAILY', from: '2026-10-01', to: '2026-10-10' }],
  ['/ads/reports/backfill', { profileId: 'p-1' }],
  ['/ads/reports/r-1/retry', undefined],
  ['/ads/parity/run', { profileId: 'p-1' }],
]

describe('广告报表与指标接口：登录与权限', () => {
  it('读接口：未登录 401；没有 ads.read 403，并且先于参数校验', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    for (const path of READS) {
      expect((await harness.call('GET', path, { auth: false })).status, path).toBe(401)
      expect((await harness.call('GET', path)).status, path).toBe(403)
    }
    expect((await harness.call('GET', '/ads/reports?status=DONE')).status).toBe(403)
    expect((await harness.call('GET', '/ads/metrics?dataset=ORDERS')).status).toBe(403)
  })

  it('写接口：未登录 401；只有 ads.read 没有 ads.report 是 403（不管请求体对不对）', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    for (const [path, body] of WRITES) {
      expect((await harness.call('POST', path, { auth: false, body })).status, path).toBe(401)
      expect((await harness.call('POST', path, { body })).status, path).toBe(403)
    }
    expect((await harness.call('POST', '/ads/reports', { body: { templateKey: 'NOPE' } })).status).toBe(403)
  })

  it('没有给指标页的写入口：POST、PATCH、DELETE /ads/metrics 都找不到', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.report']))
    expect((await harness.call('POST', '/ads/metrics', { body: {} })).status).toBe(404)
    expect((await harness.call('PATCH', '/ads/metrics', { body: {} })).status).toBe(404)
    expect((await harness.call('DELETE', '/ads/metrics')).status).toBe(404)
  })
})

describe('广告报表接口：参数校验', () => {
  it('列表：状态、来源、模板、排序字段、分页参数不合法一律 422；未知参数也拒绝', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    const status = async (query: string) => (await harness!.call('GET', `/ads/reports?${query}`)).status
    expect(await status('status=DONE')).toBe(422)
    expect(await status('source=OLD')).toBe(422)
    expect(await status('templateKey=NOPE')).toBe(422)
    expect(await status('sort=status:asc')).toBe(422)
    expect(await status('pageSize=0')).toBe(422)
    expect(await status('unknown=1')).toBe(422)
  })

  it('创建：模板、日期格式、多余字段、档案编号不合法 422（已有 ads.report 权限）', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.report']))
    const post = async (body: unknown) => (await harness!.call('POST', '/ads/reports', { body })).status
    const good = { profileId: 'p-1', templateKey: 'CAMPAIGN_DAILY', from: '2026-10-01', to: '2026-10-10' }
    expect(await post({ ...good, templateKey: 'NOPE' })).toBe(422)
    expect(await post({ ...good, from: '10/01' })).toBe(422)
    expect(await post({ ...good, reportType: 'spCampaigns' })).toBe(422)
    expect(await post({ ...good, profileId: 'a b;drop' })).toBe(422)
    expect(await post({ profileId: 'p-1' })).toBe(422)
  })

  it('回补与核对触发：月数、档案编号不合法 422', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.report']))
    expect((await harness.call('POST', '/ads/reports/backfill', { body: { profileId: 'p-1', months: 26 } })).status).toBe(422)
    expect((await harness.call('POST', '/ads/reports/backfill', { body: { months: 6 } })).status).toBe(422)
    expect((await harness.call('POST', '/ads/parity/run', { body: {} })).status).toBe(422)
  })

  it('重试与核对明细：编号不合法按不存在处理', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.report']))
    expect((await harness.call('POST', `/ads/reports/${encodeURIComponent('a b;drop')}/retry`)).status).toBe(404)
    expect((await harness.call('GET', `/ads/parity/${encodeURIComponent('a b;drop')}/diffs`)).status).toBe(404)
  })
})

describe('广告指标接口：参数校验', () => {
  it('数据集、粒度、广告产品、排序字段、分页参数不合法一律 422；未知参数也拒绝', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    const status = async (query: string) => (await harness!.call('GET', `/ads/metrics?${query}`)).status
    expect(await status('dataset=ORDERS')).toBe(422)
    expect(await status('grain=year')).toBe(422)
    expect(await status('adProduct=SB')).toBe(422)
    expect(await status('sort=name:asc')).toBe(422)
    expect(await status('pageSize=0')).toBe(422)
    expect(await status('unknown=1')).toBe(422)
  })

  it('维度与指标的组合：数据集不支持、数量超限、没选指标、排序指标没选，都是 422 并说明原因', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    const body = async (query: string) => {
      const res = await harness!.call('GET', `/ads/metrics?${query}`)
      return { status: res.status, message: JSON.stringify(res.json) }
    }
    expect(await body('dataset=PLACEMENT&dims=searchTerm&metrics=spend')).toMatchObject({ status: 422 })
    expect((await body('dataset=PLACEMENT&dims=searchTerm&metrics=spend')).message).toContain('不支持维度')
    expect((await body('dataset=CONVERTED_PRODUCT&metrics=acos')).message).toContain('不支持指标')
    expect((await body('dataset=CAMPAIGN&dims=date&metrics=')).status).toBe(422)
    expect((await body('dataset=CAMPAIGN&dims=date&metrics=,')).message).toContain('至少选一个指标')
    expect((await body('dataset=CAMPAIGN&dims=date&metrics=spend,sales,acos,roas,ctr,cpc,cvr')).message).toContain('最多选 6 个指标')
    expect((await body('dataset=PLACEMENT&metrics=spend&adProduct=SPONSORED_PRODUCTS')).message).toContain('没有广告产品列')
    expect((await body('dataset=CAMPAIGN&dims=date&metrics=spend&sort=acos:desc')).message).toContain('排序的指标必须是已选的指标')
    expect((await body('dataset=CAMPAIGN&dims=bogus&metrics=spend')).status).toBe(422)
  })
})
