import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 自定义报表（P6-32，真实数据库）：字段权限把广告列和引用广告的自定义指标拿掉；数据范围只看见被授权的店铺。

type Member = { userId: string; token: string }

describe('自定义报表（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let storeA: string
  let owner: Member
  let viewer: Member
  let narrow: Member

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'p632' })
    const tenant = await h.createTenant('p632')
    tenantId = tenant.tenantId
    storeA = tenant.sellerAccountId
    const storeB = 'store-p632-b'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: tenant.legalEntityId, displayName: '二店', sellerId: 'SELLER-P632-B', logicalRegion: 'NA2' })
    await insertRow(h.client, 'Role', {
      id: 'role-p632-full',
      tenantId,
      name: '全',
      permissions: JSON.stringify(['reports.read', 'reports.custom.write', 'reports.custom.share', 'analytics.read', 'ads.read', 'field.profit', 'export.create']),
      resourceScope: '{}',
      version: 2,
    })
    await insertRow(h.client, 'Role', {
      id: 'role-p632-view',
      tenantId,
      name: '看',
      permissions: JSON.stringify(['reports.read', 'analytics.read']),
      resourceScope: '{}',
      version: 2,
    })
    owner = await h.createMember(tenantId, 'p632-owner', [], { roleId: 'role-p632-full' })
    viewer = await h.createMember(tenantId, 'p632-view', [], { roleId: 'role-p632-view' })
    narrow = await h.createMember(tenantId, 'p632-narrow', [], { roleId: 'role-p632-full', scopes: [{ sellerAccountId: storeA }] })
    for (const [id, store, asin] of [
      ['sum-p632-a', storeA, 'B00P632AAA'],
      ['sum-p632-b', storeB, 'B00P632BBB'],
    ] as const) {
      await insertRow(h.client, 'AsinDailySummary', {
        id,
        tenantId,
        sellerAccountId: store,
        summaryDate: '2026-10-01',
        asin,
        units: 2,
        salesAmount: 20,
        adsSpend: 4,
        currency: 'USD',
        metricVersion: 'v1',
      })
    }
  })

  afterAll(async () => {
    await h?.close()
  })

  const send = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, { body })

  it('没有 reports.read 时先 403；除以常数 0 不能保存；页大小超过 200 是 422', async () => {
    expect((await send(viewer, 'POST', '/custom-metrics', { key: 'C-NO', name: '不行', expression: 'M-001', dimensions: ['asin'], format: 'number' })).status).toBe(403)
    const bad = await send(owner, 'POST', '/custom-metrics', { key: 'C-ZERO', name: '除零', expression: 'M-001 / 0', dimensions: ['asin'], format: 'number' })
    expect(bad.status).toBe(422)
    const huge = await send(owner, 'POST', '/report-sources/product-performance/query?from=2026-10-01&to=2026-10-01', { dimension: 'asin', metrics: ['sales'], pageSize: 201 })
    expect(huge.status).toBe(422)
  })

  it('查看人没有广告权限时，广告列和引用广告花费的自定义指标都不返回', async () => {
    const created = await send(owner, 'POST', '/custom-metrics', { key: 'C-GAP', name: '扣广告', expression: 'M-001 - M-007', dimensions: ['asin'], format: 'money' })
    expect(created.status).toBe(201)
    const path = '/report-sources/product-performance/query?from=2026-10-01&to=2026-10-01'
    const body = { dimension: 'asin', metrics: ['sales', 'adSpend', 'C-GAP'] }
    const seen = await send(viewer, 'POST', path, body)
    expect(seen.status).toBe(200)
    const keys = seen.json.data.columns.map((column: { key: string }) => column.key)
    expect(keys).toContain('sales')
    expect(keys).not.toContain('adSpend')
    expect(keys).not.toContain('C-GAP')
    expect(seen.json.data.restrictions.join('')).toContain('广告')
    const full = await send(owner, 'POST', path, body)
    expect(full.status).toBe(200)
    expect(full.json.data.columns.map((column: { key: string }) => column.key)).toEqual(expect.arrayContaining(['sales', 'adSpend', 'C-GAP']))
    expect(full.json.data.rows.length).toBe(2)
  })

  it('自定义指标套一层别的自定义指标，也不能绕过字段门', async () => {
    const nested = await send(owner, 'POST', '/custom-metrics', { key: 'C-NEST', name: '套娃', expression: 'C-GAP * 2', dimensions: ['asin'], format: 'money' })
    expect(nested.status).toBe(201)
    const path = '/report-sources/product-performance/query?from=2026-10-01&to=2026-10-01'
    const seen = await send(viewer, 'POST', path, { dimension: 'asin', metrics: ['sales', 'C-GAP', 'C-NEST'] })
    expect(seen.status).toBe(200)
    expect(seen.json.data.columns.map((column: { key: string }) => column.key)).toEqual(['sales'])
    const full = await send(owner, 'POST', path, { dimension: 'asin', metrics: ['C-NEST'] })
    expect(full.status).toBe(200)
    expect(full.json.data.columns.map((column: { key: string }) => column.key)).toEqual(['C-NEST'])
    expect(full.json.data.rows[0].values['C-NEST']).not.toBeNull()
  })

  it('共享报表由查看人按自己的权限运行；更新不带 shared 时保持共享；未知指标保存时 422', async () => {
    const config = { dimension: 'asin', metrics: ['sales', 'adSpend', 'C-GAP'], from: '2026-10-01', to: '2026-10-01' }
    const unknown = await send(owner, 'POST', '/custom-reports', { name: '坏', source: 'product-performance', config: { ...config, metrics: ['nope'] } })
    expect(unknown.status).toBe(422)
    const longRange = await send(owner, 'POST', '/custom-reports', { name: '长', source: 'product-performance', config: { ...config, from: '2020-01-01' } })
    expect(longRange.status).toBe(422)
    const created = await send(owner, 'POST', '/custom-reports', { name: '共享表', source: 'product-performance', shared: true, config })
    expect(created.status).toBe(201)
    const id = created.json.data.id as string
    const updated = await send(owner, 'PUT', `/custom-reports/${id}`, { name: '共享表二', source: 'product-performance', config, version: created.json.data.version })
    expect(updated.status).toBe(200)
    expect(updated.json.data.shared).toBe(true)
    const seen = await send(viewer, 'POST', `/custom-reports/${id}/run`, {})
    expect(seen.status).toBe(200)
    const keys = seen.json.data.columns.map((column: { key: string }) => column.key)
    expect(keys).toContain('sales')
    expect(keys).not.toContain('adSpend')
    expect(keys).not.toContain('C-GAP')
  })

  it('跨企业：别的企业看不到、运行不了、改不了本企业的报表与自定义指标；查询只返回自己企业的行', async () => {
    const other = await h.createTenant('p632x')
    await insertRow(h.client, 'Role', {
      id: 'role-p632x',
      tenantId: other.tenantId,
      name: '别家',
      permissions: JSON.stringify(['reports.read', 'reports.custom.write', 'reports.custom.share', 'analytics.read', 'ads.read', 'field.profit']),
      resourceScope: '{}',
      version: 2,
    })
    const stranger = await h.createMember(other.tenantId, 'p632x-owner', [], { roleId: 'role-p632x' })
    const config = { dimension: 'asin', metrics: ['sales'], from: '2026-10-01', to: '2026-10-01' }
    const report = await send(owner, 'POST', '/custom-reports', { name: '跨企业报表', source: 'product-performance', shared: true, config })
    expect(report.status).toBe(201)
    const reportId = report.json.data.id as string
    const metric = await send(owner, 'POST', '/custom-metrics', { key: 'C-XTEN', name: '跨企业指标', expression: 'M-001 * 2', dimensions: ['asin'], format: 'number' })
    expect(metric.status).toBe(201)
    expect((await send(stranger, 'POST', `/custom-reports/${reportId}/run`, {})).status).toBe(404)
    expect((await send(stranger, 'PUT', `/custom-reports/${reportId}`, { name: '抢改', source: 'product-performance', config, version: report.json.data.version })).status).toBe(404)
    expect((await send(stranger, 'DELETE', `/custom-reports/${reportId}`)).status).toBe(404)
    expect(
      (
        await send(stranger, 'PUT', `/custom-metrics/${metric.json.data.id}`, {
          key: 'C-XTEN',
          name: '抢改',
          expression: 'M-001',
          dimensions: ['asin'],
          format: 'number',
          version: metric.json.data.version,
        })
      ).status,
    ).toBe(404)
    expect((await send(stranger, 'DELETE', `/custom-metrics/${metric.json.data.id}`)).status).toBe(404)
    const reports = await send(stranger, 'GET', '/custom-reports')
    expect(reports.status).toBe(200)
    expect(JSON.stringify(reports.json.data)).not.toContain('跨企业报表')
    const metrics = await send(stranger, 'GET', '/custom-metrics')
    expect(metrics.status).toBe(200)
    expect(JSON.stringify(metrics.json.data)).not.toContain('C-XTEN')
    const query = await send(stranger, 'POST', '/report-sources/product-performance/query?from=2026-10-01&to=2026-10-01', { dimension: 'asin', metrics: ['sales'] })
    expect(query.status).toBe(200)
    expect(query.json.data.rows).toHaveLength(0)
    expect((await send(owner, 'POST', `/custom-reports/${reportId}/run`, {})).status).toBe(200)
  })

  it('数据范围只包含一个店铺时，只能看到这个店铺的行', async () => {
    const res = await send(narrow, 'POST', '/report-sources/product-performance/query?from=2026-10-01&to=2026-10-01', { dimension: 'asin', metrics: ['sales'] })
    expect(res.status).toBe(200)
    expect(res.json.data.rows).toHaveLength(1)
    expect(String(res.json.data.rows[0].id)).toContain('B00P632AAA')
  })
})
