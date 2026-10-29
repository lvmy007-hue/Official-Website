import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 自定义仪表盘（P6-33，真实数据库）：共享后按查看人的数据源权限降级，没有权限的组件是“无权查看”而不是错误。

type Member = { userId: string; token: string }

describe('自定义仪表盘（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let owner: Member
  let viewer: Member
  let writer: Member

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'p633' })
    const tenant = await h.createTenant('p633')
    tenantId = tenant.tenantId
    await insertRow(h.client, 'Role', {
      id: 'role-p633-owner',
      tenantId,
      name: '建',
      permissions: JSON.stringify(['dashboard.write', 'dashboard.share', 'ads.read', 'inventory.read', 'reports.read', 'analytics.read']),
      resourceScope: '{}',
      version: 2,
    })
    await insertRow(h.client, 'Role', {
      id: 'role-p633-view',
      tenantId,
      name: '看',
      permissions: JSON.stringify(['inventory.read', 'analytics.read']),
      resourceScope: '{}',
      version: 2,
    })
    await insertRow(h.client, 'Role', {
      id: 'role-p633-write',
      tenantId,
      name: '写',
      permissions: JSON.stringify(['dashboard.write', 'inventory.read']),
      resourceScope: '{}',
      version: 2,
    })
    owner = await h.createMember(tenantId, 'p633-owner', [], { roleId: 'role-p633-owner' })
    viewer = await h.createMember(tenantId, 'p633-view', [], { roleId: 'role-p633-view' })
    writer = await h.createMember(tenantId, 'p633-write', [], { roleId: 'role-p633-write' })
  })

  afterAll(async () => {
    await h?.close()
  })

  const send = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, { body })

  it('共享仪表盘里，没有广告权限的人看到无权查看，有库存权限的人正常取数', async () => {
    const folder = await send(owner, 'POST', '/dashboards/folders', { name: '运营' })
    expect(folder.status).toBe(201)
    const created = await send(owner, 'POST', '/dashboards', { name: '晨会', folderId: folder.json.data.id, shared: true, refreshMinutes: 5 })
    expect(created.status).toBe(201)
    const id = created.json.data.id as string
    const ads = await send(owner, 'POST', `/dashboards/${id}/widgets`, {
      type: 'METRIC_CARD',
      query: { source: 'ads', dimension: 'campaign', metrics: ['spend'] },
    })
    const stock = await send(owner, 'POST', `/dashboards/${id}/widgets`, {
      type: 'TABLE',
      query: { source: 'inventory', dimension: 'sku', metrics: ['sellable'] },
    })
    const text = await send(owner, 'POST', `/dashboards/${id}/widgets`, { type: 'TEXT', options: { text: '只给团队看的说明' } })
    expect(ads.status).toBe(201)
    expect(stock.status).toBe(201)
    expect(text.status).toBe(201)
    const denied = await send(viewer, 'GET', `/dashboards/${id}/widgets/${ads.json.data.id}`)
    expect(denied.status).toBe(200)
    expect(denied.json.data).toMatchObject({ state: 'RESTRICTED', message: '无权查看' })
    const allowed = await send(viewer, 'GET', `/dashboards/${id}/widgets/${stock.json.data.id}?from=2026-10-01&to=2026-10-02`)
    expect(allowed.status).toBe(200)
    expect(allowed.json.data.state).not.toBe('RESTRICTED')
    const note = await send(viewer, 'GET', `/dashboards/${id}/widgets/${text.json.data.id}`)
    expect(note.json.data).toMatchObject({ state: 'TEXT', text: '只给团队看的说明' })
    expect((await send(viewer, 'POST', '/dashboards', { name: '不行' })).status).toBe(403)
    expect((await send(viewer, 'PUT', `/dashboards/${id}`, { name: '改名', version: created.json.data.version })).status).toBe(403)
    const hidden = await send(owner, 'POST', '/dashboards', { name: '私人' })
    expect((await send(viewer, 'GET', `/dashboards/${hidden.json.data.id}`)).status).toBe(404)
  })

  it('跨企业：别的企业的成员看不到、改不了、删不掉本企业的共享仪表盘与组件，列表里也没有', async () => {
    const other = await h.createTenant('p633x')
    await insertRow(h.client, 'Role', {
      id: 'role-p633x',
      tenantId: other.tenantId,
      name: '别家',
      permissions: JSON.stringify(['dashboard.write', 'dashboard.share', 'inventory.read', 'reports.read', 'analytics.read']),
      resourceScope: '{}',
      version: 2,
    })
    const stranger = await h.createMember(other.tenantId, 'p633x-owner', [], { roleId: 'role-p633x' })
    const created = await send(owner, 'POST', '/dashboards', { name: '跨企业', shared: true })
    const id = created.json.data.id as string
    const widget = await send(owner, 'POST', `/dashboards/${id}/widgets`, { type: 'TEXT', options: { text: '本企业的说明' } })
    expect(widget.status).toBe(201)
    const widgetId = widget.json.data.id as string
    expect((await send(stranger, 'GET', `/dashboards/${id}`)).status).toBe(404)
    expect((await send(stranger, 'GET', `/dashboards/${id}/widgets`)).status).toBe(404)
    expect((await send(stranger, 'GET', `/dashboards/${id}/widgets/${widgetId}`)).status).toBe(404)
    expect((await send(stranger, 'PUT', `/dashboards/${id}`, { name: '抢改', version: created.json.data.version })).status).toBe(404)
    expect((await send(stranger, 'DELETE', `/dashboards/${id}/widgets/${widgetId}`)).status).toBe(404)
    expect((await send(stranger, 'DELETE', `/dashboards/${id}`)).status).toBe(404)
    expect((await send(stranger, 'POST', `/dashboards/${id}/widgets`, { type: 'TEXT', options: { text: '塞进去' } })).status).toBe(404)
    const listed = await send(stranger, 'GET', '/dashboards')
    expect(listed.status).toBe(200)
    expect(JSON.stringify(listed.json.data)).not.toContain('跨企业')
    const tree = await send(stranger, 'GET', '/dashboards/tree')
    expect(tree.status).toBe(200)
    expect(JSON.stringify(tree.json.data)).not.toContain('跨企业')
    expect((await send(owner, 'GET', `/dashboards/${id}/widgets/${widgetId}`)).status).toBe(200)
  })

  it('共享组件按查看人的字段门取数：广告列被挡掉，整列都被挡则无权查看；看不到的组件不暴露配置；删除组件同步布局', async () => {
    const created = await send(owner, 'POST', '/dashboards', { name: '字段门', shared: true })
    const id = created.json.data.id as string
    const mixed = await send(owner, 'POST', `/dashboards/${id}/widgets`, {
      type: 'TABLE',
      query: { source: 'product-performance', dimension: 'asin', metrics: ['sales', 'adSpend'] },
    })
    const gated = await send(owner, 'POST', `/dashboards/${id}/widgets`, {
      type: 'METRIC_CARD',
      query: { source: 'product-performance', dimension: 'asin', metrics: ['adSpend'] },
    })
    const ads = await send(owner, 'POST', `/dashboards/${id}/widgets`, { type: 'BAR', query: { source: 'ads', dimension: 'campaign', metrics: ['spend'] } })
    expect([mixed.status, gated.status, ads.status]).toEqual([201, 201, 201])
    const qs = '?from=2026-10-01&to=2026-10-01'
    const partial = await send(viewer, 'GET', `/dashboards/${id}/widgets/${mixed.json.data.id}${qs}`)
    expect(partial.status).toBe(200)
    expect(partial.json.data.state).not.toBe('RESTRICTED')
    expect(partial.json.data.result.columns.map((column: { key: string }) => column.key)).toEqual(['sales'])
    const none = await send(viewer, 'GET', `/dashboards/${id}/widgets/${gated.json.data.id}${qs}`)
    expect(none.status).toBe(200)
    expect(none.json.data).toMatchObject({ state: 'RESTRICTED', message: '无权查看' })
    const detail = await send(viewer, 'GET', `/dashboards/${id}`)
    const seenAds = detail.json.data.widgets.find((widget: { id: string }) => widget.id === ads.json.data.id)
    expect(seenAds.query).toEqual({})
    const listed = await send(viewer, 'GET', `/dashboards/${id}/widgets`)
    expect(listed.json.data.items.find((widget: { id: string }) => widget.id === ads.json.data.id).query).toEqual({})
    expect((await send(viewer, 'DELETE', `/dashboards/${id}/widgets/${ads.json.data.id}`)).status).toBe(403)
    expect((await send(owner, 'DELETE', `/dashboards/${id}/widgets/${ads.json.data.id}`)).status).toBe(200)
    const after = await send(owner, 'GET', `/dashboards/${id}`)
    expect(after.json.data.widgets).toHaveLength(2)
    expect(after.json.data.layout.items.map((item: { widgetId: string }) => item.widgetId)).not.toContain(ads.json.data.id)
  })

  it('没有共享权限不能把仪表盘标成共享；版本过期返回 409', async () => {
    expect((await send(writer, 'POST', '/dashboards', { name: '想共享', shared: true })).status).toBe(403)
    const created = await send(writer, 'POST', '/dashboards', { name: '自己的', refreshMinutes: 15 })
    expect(created.status).toBe(201)
    const id = created.json.data.id as string
    const stale = await send(writer, 'PUT', `/dashboards/${id}`, { name: '自己的', version: 1, refreshMinutes: 30 })
    expect(stale.status).toBe(200)
    const again = await send(writer, 'PUT', `/dashboards/${id}`, { name: '再改', version: 1 })
    expect(again.status).toBe(409)
    const detail = await send(writer, 'GET', `/dashboards/${id}`)
    expect(detail.json.data.refreshMinutes).toBe(30)
    expect(detail.json.data.layout.items).toEqual([])
  })
})
