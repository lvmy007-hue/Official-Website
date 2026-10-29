import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 物流渠道报价与预估头程费用、货件三种差异（P6-26，真实数据库 + 完整应用）：
// 物流商 / 渠道 / 阶梯报价（唯一、重叠、乐观锁、在用不能删、金额权限）、按渠道预估（计费重量、分抛、缺字段、无报价）、批量补录、
// 采用预估后的异常单筛选、货件申报 / 已发 / 签收差异与快捷筛选、租户隔离。

type Member = { userId: string; token: string }
type Json = { id: string; shipmentId: string; sku: string; weightKg: number }
const DAY = 86_400_000
const dayText = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)

describe('物流渠道报价与预估头程（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerAccountId: string
  let owner: Member
  let noCost: Member
  let readOnly: Member
  let other: Member
  let forwarderId: string
  let carrierId: string
  let channelId: string
  let seq = 0

  const call = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, body === undefined ? {} : { body })
  const ok = async (member: Member, method: string, path: string, body?: unknown) => {
    const res = await call(member, method, path, body)
    expect(res.status, `${method} ${path} → ${JSON.stringify(res.json)}`).toBeLessThan(300)
    return res.json.data
  }
  const rateBody = (extra: Record<string, unknown> = {}) => ({
    region: 'US-West',
    weightFrom: 0,
    weightTo: 100,
    unitPrice: 5,
    currency: 'USD',
    billingMode: 'PER_KG',
    effectiveFrom: dayText(-30),
    effectiveTo: null,
    ...extra,
  })
  const shipment = async (extra: Record<string, unknown> = {}) =>
    (await ok(owner, 'POST', '/first-mile', {
      forwarderId,
      waybillNo: `CR-${++seq}`,
      mode: 'AIR',
      customsStatus: 'NOT_STARTED',
      currency: 'USD',
      linkedInboundShipmentIds: [],
      items: [{ sku: 'CR-A', quantity: 10, weightKg: 60, volumeCbm: 0.2 }],
      ...extra,
    })) as { id: string; version: number }

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'carriers', db })
    const a = await h.createTenant('cr-a')
    tenantId = a.tenantId
    sellerAccountId = a.sellerAccountId
    const b = await h.createTenant('cr-b')
    owner = await h.createMember(tenantId, 'cr-owner', ['*'])
    noCost = await h.createMember(tenantId, 'cr-nocost', ['firstmile.read', 'firstmile.write', 'inbound.read'])
    readOnly = await h.createMember(tenantId, 'cr-readonly', ['firstmile.read', 'field.cost'])
    other = await h.createMember(b.tenantId, 'cr-other', ['*'])
    forwarderId = (await ok(owner, 'POST', '/freight-forwarders', { name: '空运通', defaultMode: 'AIR' })).id
  })
  afterAll(async () => {
    await h?.close()
  })

  describe('物流商与渠道', () => {
    it('创建：无权限 403、代码唯一 409、乐观锁、渠道参数校验', async () => {
      expect((await call(readOnly, 'POST', '/first-mile/carriers', { name: '无权', code: 'NOPE' })).status).toBe(403)
      const carrier = await ok(owner, 'POST', '/first-mile/carriers', { name: '甲物流', code: 'jia' })
      carrierId = carrier.id
      expect(carrier).toMatchObject({ version: 1 })
      expect((await call(owner, 'POST', '/first-mile/carriers', { name: '重复', code: 'JIA' })).status).toBe(409)
      expect((await call(owner, 'PUT', `/first-mile/carriers/${carrierId}`, { version: 9, name: '过期' })).status).toBe(409)
      expect(await ok(owner, 'PUT', `/first-mile/carriers/${carrierId}`, { version: 1, name: '甲物流（改）' })).toMatchObject({ version: 2 })

      expect((await call(owner, 'POST', `/first-mile/carriers/${carrierId}/channels`, { name: '坏', code: 'BAD', volumetricDivisor: 6000, splitFactor: 0 })).status).toBe(422)
      const channel = await ok(owner, 'POST', `/first-mile/carriers/${carrierId}/channels`, { name: '空运特快', code: 'air', volumetricDivisor: 6000, splitFactor: 1 })
      channelId = channel.id
      expect(channel).toMatchObject({ version: 1 })
      expect((await call(owner, 'POST', `/first-mile/carriers/${carrierId}/channels`, { name: '重复', code: 'AIR', volumetricDivisor: 5000, splitFactor: 1 })).status).toBe(409)
    })

    it('列表带渠道；没有管理权限的人能看但 canManage 为 false 并给出原因', async () => {
      const mine = await ok(owner, 'GET', '/first-mile/carriers')
      expect(mine).toMatchObject({ total: 1, canManage: true })
      expect(mine.items[0].channels).toEqual([expect.objectContaining({ code: 'AIR', rateCount: 0, shipmentCount: 0 })])
      const viewer = await ok(readOnly, 'GET', '/first-mile/carriers')
      expect(viewer.canManage).toBe(false)
      expect(viewer.manageBlockedReason).toBeTruthy()
      expect((await ok(other, 'GET', '/first-mile/carriers')).total).toBe(0)
    })
  })

  describe('阶梯报价', () => {
    const path = () => `/first-mile/carriers/${carrierId}/channels/${channelId}/rates`

    it('新增、重叠 409、边界相接可以、币种与区间校验、金额字段权限', async () => {
      const first = await ok(owner, 'POST', path(), rateBody())
      expect(first).toMatchObject({ version: 1 })
      expect((await call(owner, 'POST', path(), rateBody({ weightFrom: 50, weightTo: 150 }))).status).toBe(409)
      await ok(owner, 'POST', path(), rateBody({ weightFrom: 100, weightTo: null, unitPrice: 4 }))
      await ok(owner, 'POST', path(), rateBody({ region: 'US-East' }))
      expect((await call(owner, 'POST', path(), rateBody({ weightTo: 0 }))).status).toBe(422)
      expect((await call(owner, 'POST', path(), rateBody({ currency: 'US' }))).status).toBe(422)
      expect((await call(readOnly, 'POST', path(), rateBody({ region: 'EU' }))).status).toBe(403)

      const list = await ok(owner, 'GET', path())
      expect(list.total).toBe(3)
      expect(list.regions).toEqual(['US-East', 'US-West'])
      expect(list.items[0].unitPrice).toBeDefined()
      expect((await ok(owner, 'GET', `${path()}?region=US-East`)).total).toBe(1)
      const hidden = await ok(noCost, 'GET', path())
      expect(hidden.items[0]).not.toHaveProperty('unitPrice')
    })

    it('修改：乐观锁；改后重叠被拒绝；删除；别的企业访问不到', async () => {
      const row = await ok(owner, 'POST', path(), rateBody({ region: 'EU', weightTo: 10 }))
      expect((await call(owner, 'PUT', `${path()}/${row.id}`, { version: 7, unitPrice: 9 })).status).toBe(409)
      expect(await ok(owner, 'PUT', `${path()}/${row.id}`, { version: 1, unitPrice: 9 })).toMatchObject({ version: 2 })
      await ok(owner, 'POST', path(), rateBody({ region: 'EU', weightFrom: 10, weightTo: 20 }))
      expect((await call(owner, 'PUT', `${path()}/${row.id}`, { version: 2, weightTo: 15 })).status).toBe(409)
      expect((await call(other, 'GET', path())).status).toBeGreaterThanOrEqual(400)
      expect((await call(owner, 'DELETE', `${path()}/${row.id}?version=2`)).status).toBeLessThan(300)
      expect((await ok(owner, 'GET', `${path()}?region=EU`)).total).toBe(1)
    })
  })

  describe('按渠道预估与补录', () => {
    it('预估：重量 60 体积 0.2 → 计费重量 60，用第一档 5/kg；不落库，运单上的预估不变', async () => {
      const row = await shipment({ carrierChannelId: channelId })
      const res = await ok(owner, 'POST', `/first-mile/${row.id}/estimate`, { region: 'US-West' })
      expect(res.estimate).toMatchObject({ state: 'OK', actualKg: 60, volumetricKg: 33.3333, chargeableKg: 60, amount: 300, currency: 'USD' })
      const view = await ok(owner, 'GET', `/first-mile/${row.id}`)
      expect(view.shipment.estimatedCost).toBeNull()
      expect(view.missingFields).toEqual([])
    })

    it('泡货按体积重落到更高阶梯；金额字段无 cost 权限时不返回', async () => {
      const row = await shipment({ carrierChannelId: channelId, items: [{ sku: 'CR-B', quantity: 1, weightKg: 60, volumeCbm: 0.9 }] })
      const res = await ok(owner, 'POST', `/first-mile/${row.id}/estimate`, { region: 'US-West' })
      expect(res.estimate).toMatchObject({ state: 'OK', chargeableKg: 150, amount: 600 })
      const hidden = await ok(noCost, 'POST', `/first-mile/${row.id}/estimate`, { region: 'US-West' })
      expect(hidden.estimate).not.toHaveProperty('amount')
    })

    it('没有报价的地区、没选渠道都不预估并说明原因', async () => {
      const row = await shipment({ carrierChannelId: channelId })
      const none = await ok(owner, 'POST', `/first-mile/${row.id}/estimate`, { region: 'MARS' })
      expect(none.estimate).toMatchObject({ state: 'BLOCKED', block: 'NO_RATE', amount: null })
      const bare = await shipment()
      expect((await call(owner, 'POST', `/first-mile/${bare.id}/estimate`, { region: 'US-West' })).status).toBe(422)
      expect((await call(owner, 'POST', `/first-mile/${bare.id}/estimate`, { region: 'US-West', channelId })).status).toBeLessThan(300)
    })

    it('缺重量体积：详情列出缺项与按商品档案算出的建议；预估被拒绝；补录只补空的并升版本', async () => {
      await insertRow(h.client as Client, 'FbaProduct', {
        id: 'cr-prod',
        tenantId,
        sellerAccountId,
        sellerSku: 'CR-MISS',
        asin: 'B0CRMISS01',
        title: '缺项品',
        packageLengthCm: 50,
        packageWidthCm: 40,
        packageHeightCm: 30,
        packageWeightKg: 2,
      })
      const row = await shipment({
        carrierChannelId: channelId,
        items: [
          { sku: 'CR-MISS', quantity: 5 },
          { sku: 'CR-FULL', quantity: 1, weightKg: 3, volumeCbm: 0.01 },
        ],
      })
      const view = await ok(owner, 'GET', `/first-mile/${row.id}`)
      expect(view.missingFields).toEqual([{ sku: 'CR-MISS', missing: ['WEIGHT', 'VOLUME'], suggestedWeightKg: 10, suggestedVolumeCbm: 0.3 }])
      const blocked = await ok(owner, 'POST', `/first-mile/${row.id}/estimate`, { region: 'US-West' })
      expect(blocked.estimate).toMatchObject({ state: 'BLOCKED', block: 'MISSING_FIELDS' })

      expect((await call(readOnly, 'POST', `/first-mile/${row.id}/items/fill`, { version: 1, rows: [{ sku: 'CR-MISS', weightKg: 10 }] })).status).toBe(403)
      expect((await call(owner, 'POST', `/first-mile/${row.id}/items/fill`, { version: 5, rows: [{ sku: 'CR-MISS', weightKg: 10 }] })).status).toBe(409)
      const filled = await ok(owner, 'POST', `/first-mile/${row.id}/items/fill`, {
        version: 1,
        rows: [
          { sku: 'CR-MISS', weightKg: 10, volumeCbm: 0.3 },
          { sku: 'CR-FULL', weightKg: 99 },
        ],
      })
      expect(filled).toMatchObject({ version: 2, filled: 1 })
      const after = await ok(owner, 'GET', `/first-mile/${row.id}`)
      expect(after.missingFields).toEqual([])
      expect(after.items.find((item: Json) => item.sku === 'CR-FULL').weightKg).toBe(3)
      const estimate = await ok(owner, 'POST', `/first-mile/${row.id}/estimate`, { region: 'US-West' })
      expect(estimate.estimate).toMatchObject({ state: 'OK', actualKg: 13 })
    })

    it('采用预估：写入渠道与预估时间；实际费用偏差达到阈值进入异常单筛选', async () => {
      const row = await shipment({ carrierChannelId: channelId })
      await ok(owner, 'PATCH', `/first-mile/${row.id}`, { version: 1, carrierChannelId: channelId, estimatedCost: 300 })
      const adopted = await ok(owner, 'GET', `/first-mile/${row.id}`)
      expect(adopted.shipment.estimatedAt).toBeTruthy()
      expect(adopted.shipment.carrierChannelName).toBe('甲物流（改） · 空运特快')
      expect(adopted.shipment.deviationPct).toBeNull()
      await ok(owner, 'POST', `/first-mile/${row.id}/costs`, { version: 2, item: 'FREIGHT', amount: 420, incurredAt: dayText(-1) })
      const view = await ok(owner, 'GET', `/first-mile/${row.id}`)
      expect(view.shipment.deviationPct).toBe(40)
      const abnormal = await ok(owner, 'GET', '/first-mile?deviation=1&deviationPct=20')
      expect(abnormal.items.map((item: Json) => item.id)).toContain(row.id)
      const strict = await ok(owner, 'GET', '/first-mile?deviation=1&deviationPct=50')
      expect(strict.items.map((item: Json) => item.id)).not.toContain(row.id)
      expect((await call(noCost, 'GET', '/first-mile?deviation=1')).status).toBeGreaterThanOrEqual(400)
    })

    it('在用的渠道不能删除，停用的渠道不能被选', async () => {
      expect((await call(owner, 'DELETE', `/first-mile/carriers/${carrierId}/channels/${channelId}?version=1`)).status).toBe(409)
      const spare = await ok(owner, 'POST', `/first-mile/carriers/${carrierId}/channels`, { name: '停用渠道', code: 'OFF', volumetricDivisor: 5000, splitFactor: 0.5 })
      await ok(owner, 'PUT', `/first-mile/carriers/${carrierId}/channels/${spare.id}`, { version: 1, status: 'INACTIVE' })
      expect(
        (
          await call(owner, 'POST', '/first-mile', {
            forwarderId,
            waybillNo: 'CR-OFF',
            mode: 'AIR',
            customsStatus: 'NOT_STARTED',
            currency: 'USD',
            linkedInboundShipmentIds: [],
            carrierChannelId: spare.id,
            items: [{ sku: 'X', quantity: 1 }],
          })
        ).status,
      ).toBe(422)
    })
  })

  describe('货件三种差异', () => {
    const seed = async (key: string, status: string, declared: number, items: Array<[number, number | null]>) => {
      const plan = await insertRow(h.client as Client, 'FbaInboundPlan', { id: `gp-${key}`, tenantId, sellerAccountId, name: `差异-${key}` })
      await insertRow(h.client as Client, 'FbaInboundShipment', { id: `gs-${key}`, planId: plan.id, shipmentId: `GAP-${key}`, status, unitsExpected: declared })
      let n = 0
      for (const [shipped, received] of items) {
        await insertRow(h.client as Client, 'ShipmentItem', {
          id: `gi-${key}-${++n}`,
          tenantId,
          planId: plan.id,
          shipmentId: `GAP-${key}`,
          sku: `S-${key}-${n}`,
          shippedQty: shipped,
          receivedQty: received,
        })
      }
    }

    it('申报 / 已发 / 签收三列与两两差异；签收差异只在关闭后判定；快捷筛选；没有数据不是 0', async () => {
      await seed('SHORT', 'CLOSED', 100, [
        [60, 55],
        [40, 35],
      ])
      await seed('FULL', 'CLOSED', 50, [[50, 50]])
      await seed('OPEN', 'RECEIVING', 80, [[70, null]])
      const all = await ok(owner, 'GET', '/inbound/shipments/discrepancies?pageSize=100')
      const row = (shipmentId: string) => all.items.find((item: Json) => item.shipmentId === shipmentId)
      expect(row('GAP-SHORT')).toMatchObject({ declared: 100, shipped: 100, received: 90, declaredVsShipped: 0, shippedVsReceived: 10, declaredVsReceived: 10 })
      expect(row('GAP-FULL')).toMatchObject({ declaredVsReceived: 0, shippedVsReceived: 0 })
      expect(row('GAP-OPEN')).toMatchObject({ declared: 80, shipped: 70, received: null, declaredVsShipped: 10, shippedVsReceived: null, declaredVsReceived: null })

      const ids = async (query: string) => (await ok(owner, 'GET', `/inbound/shipments/discrepancies?${query}`)).items.map((item: Json) => item.shipmentId).sort()
      expect(await ids('gap=DECLARED_GT_RECEIVED')).toEqual(['GAP-SHORT'])
      expect(await ids('gap=SHIPPED_GT_RECEIVED')).toEqual(['GAP-SHORT'])
      expect(await ids('gap=DECLARED_GT_SHIPPED')).toEqual(['GAP-OPEN'])
      expect(await ids('q=FULL')).toEqual(['GAP-FULL'])
      expect((await call(owner, 'GET', '/inbound/shipments/discrepancies?gap=BAD')).status).toBe(422)
      expect((await call(other, 'GET', '/inbound/shipments/discrepancies')).json.data.items).toEqual([])
    })
  })
})
