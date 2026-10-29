import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { insertRow } from './db-fixtures'

// 今日实时（P2a-03，真实数据库）：未接入退化日终、接入后累计与小时曲线、异常检测、事件流、租户隔离。

type Ids = Awaited<ReturnType<DbTestApp['createTenant']>>
type Member = { userId: string; token: string }

describe('今日实时（真实数据库）', () => {
  let h: DbTestApp
  let a: Ids
  let b: Ids
  let owner: Member
  let seq = 0
  const prevDest = process.env.AMAZON_NOTIFICATION_DESTINATION_ID

  const get = async (member: Member, path: string) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, `${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'today' })
    a = await h.createTenant('tda')
    b = await h.createTenant('tdb')
    owner = await h.createMember(a.tenantId, 'td-owner', ['*'])
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE "id" = $1`, [a.tenantId])

    // 日终退化：昨天有汇总
    await insertRow(h.client, 'StoreDailySummary', {
      id: `sd-${++seq}`,
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      summaryDate: '2026-10-21',
      orders: 4,
      units: 7,
      salesAmount: 70,
      metricVersion: 'p2a-01@1',
      refreshedAt: '2026-10-22T01:00:00Z',
    })

    // 租户 B 的小时事件：不得泄漏
    await insertRow(h.client, 'HourlySalesEvent', {
      id: `hs-b-${++seq}`,
      tenantId: b.tenantId,
      sellerAccountId: b.sellerAccountId,
      asin: 'B999',
      hourStart: '2026-10-22T10:00:00Z',
      units: 999,
      salesAmount: 9999,
      currency: 'USD',
      orders: 0,
      isLateArrival: false,
      sourceUpdatedAt: '2026-10-22T10:05:00Z',
      updatedAt: '2026-10-22T10:05:00Z',
    })
  })

  afterAll(async () => {
    if (prevDest === undefined) delete process.env.AMAZON_NOTIFICATION_DESTINATION_ID
    else process.env.AMAZON_NOTIFICATION_DESTINATION_ID = prevDest
    await h?.close()
  })

  it('接收端未配置：返回 NOT_CONNECTED，并退化展示日终汇总', async () => {
    delete process.env.AMAZON_NOTIFICATION_DESTINATION_ID
    const data = await get(owner, '/today/summary')
    expect(data.realtimeState).toBe('NOT_CONNECTED')
    expect(data.dailyFallback).toMatchObject({ units: 7, salesAmount: 70, orders: 4, summaryDate: '2026-10-21' })
    expect(data.totals).toMatchObject({ units: 7, salesAmount: 70, orders: 4 })
    expect(data.ads.state).toBe('NOT_CONNECTED')
  })

  it('接收端已配置：读小时销售累计、小时曲线、异常、库存断货与预计断货', async () => {
    process.env.AMAZON_NOTIFICATION_DESTINATION_ID = 'dest-test'
    // 相对“当前整点”造数：累计只含截至当前小时的数据，不能写死未来小时；且必须落在今天（UTC）
    const nowHour = new Date()
    nowHour.setUTCMinutes(0, 0, 0)
    const dayStart = new Date(Date.UTC(nowHour.getUTCFullYear(), nowHour.getUTCMonth(), nowHour.getUTCDate()))
    const hourB = nowHour < dayStart ? dayStart : nowHour
    const prev = new Date(hourB.getTime() - 3_600_000)
    const hourA = prev < dayStart ? dayStart : prev
    // 过去同星期几同小时的样本（四周）——对着 hourA，保证异常检测命中
    for (let week = 1; week <= 4; week += 1) {
      const past = new Date(hourA.getTime() - week * 7 * 24 * 3_600_000)
      await insertRow(h.client, 'HourlySalesEvent', {
        id: `hs-hist-${week}-${++seq}`,
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        asin: 'B001',
        hourStart: past.toISOString(),
        units: 10 + week,
        salesAmount: 100 + week,
        currency: 'USD',
        orders: 0,
        isLateArrival: false,
        sourceUpdatedAt: past.toISOString(),
        updatedAt: past.toISOString(),
      })
    }
    // 每天 UTC 00:00–00:59，当前小时与上一小时都被夹到当日第一个小时（hourA === hourB），
    // 同一小时同一 ASIN 只能有一行（唯一键），此时合并成一行，累计仍是 5 件
    const sameHour = hourA.getTime() === hourB.getTime()
    if (!sameHour) {
      await insertRow(h.client, 'HourlySalesEvent', {
        id: `hs-live-${++seq}`,
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        asin: 'B001',
        hourStart: hourA.toISOString(),
        units: 2,
        salesAmount: 20,
        currency: 'USD',
        orders: 0,
        isLateArrival: false,
        sourceUpdatedAt: hourA.toISOString(),
        updatedAt: hourA.toISOString(),
      })
    }
    await insertRow(h.client, 'HourlySalesEvent', {
      id: `hs-live2-${++seq}`,
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      asin: 'B001',
      hourStart: hourB.toISOString(),
      units: sameHour ? 5 : 3,
      salesAmount: sameHour ? 50 : 30,
      currency: 'USD',
      orders: 0,
      isLateArrival: false,
      sourceUpdatedAt: hourB.toISOString(),
      updatedAt: hourB.toISOString(),
    })
    await insertRow(h.client, 'HourlyInventoryEvent', {
      id: `hi-${++seq}`,
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      asin: 'B001',
      hourStart: hourB.toISOString(),
      availableQty: 1,
      isLateArrival: false,
      sourceUpdatedAt: hourB.toISOString(),
      updatedAt: hourB.toISOString(),
    })
    await insertRow(h.client, 'HourlyInventoryEvent', {
      id: `hi0-${++seq}`,
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      asin: 'B002',
      hourStart: hourB.toISOString(),
      availableQty: 0,
      isLateArrival: false,
      sourceUpdatedAt: hourB.toISOString(),
      updatedAt: hourB.toISOString(),
    })

    const summary = await get(owner, '/today/summary')
    expect(summary.realtimeState).toBe('LIVE')
    expect(summary.totals.units).toBeGreaterThanOrEqual(2)
    expect(summary.inventory.outOfStock.some((row: { asin: string }) => row.asin === 'B002')).toBe(true)
    expect(summary.dailyFallback).toBeNull()

    const hourly = await get(owner, '/today/hourly')
    expect(hourly.realtimeState).toBe('LIVE')
    expect(hourly.hours.length).toBe(24)
    expect(hourly.anomalies.some((row: { asin: string; metric: string }) => row.asin === 'B001' && row.metric === 'sales')).toBe(true)

    // 租户隔离：A 看不到 B 在 beforeAll 里写入的 999 件
    expect(summary.totals.units).toBeLessThan(100)
    expect(summary.totals.units).toBe(5)
  })

  it('事件流：只返回本租户今日事件，不含待办类', async () => {
    process.env.AMAZON_NOTIFICATION_DESTINATION_ID = 'dest-test'
    const now = new Date()
    await insertRow(h.client, 'EntityEvent', {
      id: `ev-${++seq}`,
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      entityType: 'ASIN',
      entityId: 'B001',
      kind: 'listing.change',
      occurredAt: now.toISOString(),
      title: '刊登变更',
      actorKind: 'SYSTEM',
      sourceRef: `src-${seq}`,
    })
    await insertRow(h.client, 'EntityEvent', {
      id: `ev-wi-${++seq}`,
      tenantId: a.tenantId,
      entityType: 'WORK_ITEM',
      entityId: 'w1',
      kind: 'workitem',
      occurredAt: now.toISOString(),
      title: '待办不应出现',
      actorKind: 'SYSTEM',
      sourceRef: `src-wi-${seq}`,
    })
    const data = await get(owner, '/today/events')
    expect(data.items.some((row: { title: string }) => row.title === '刊登变更')).toBe(true)
    expect(data.items.some((row: { title: string }) => row.title === '待办不应出现')).toBe(false)
  })
})
