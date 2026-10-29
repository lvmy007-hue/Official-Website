import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// P6-13 退货分析与原因映射（真实数据库）：迁移升级回填与回滚、原因映射的读写与权限、五个分析接口
// （概览、退货周期、跨月退货、队列退货率、库存属性×处置结果）的口径：同一天、跨月、跨年、企业时区的月边界、缺下单时间单独计数、发货起点。
// 企业时区是 America/Los_Angeles：造数的时刻统一取 19:00 UTC（洛杉矶当天中午），避免日期落在边界上。

const TARGET = '20261215010000_return_reason_map'
const RANGE = 'from=2026-01-01&to=2026-09-30'

describe('退货分析与原因映射（P6-13，真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移：新表与新列，存量回填，可回滚、可再次升级', () => {
    it('升级后存量退货按订单回填下单与发货时间（同一订单多个下单时间取最早）；找不到订单的保持为空；回滚后新表与新列消失，可再次升级', async () => {
      await db.createDatabase('return_reason_upgrade')
      const client = await db.connect('return_reason_upgrade')
      try {
        await applyMigrations(client, { before: TARGET })
        const ids = await seedTenant(client, 'u')
        const store = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
        const returned = (id: string, no: string) => insertRow(client, 'FbaReturnCase', { id, ...store, amazonOrderId: no, asin: 'B000000001', sellerSku: 'SKU-1', returnDate: '2026-09-10T19:00:00Z' })
        await insertRow(client, 'Order', {
          id: 'o1',
          ...store,
          amazonOrderId: 'U-1',
          purchaseDate: '2026-09-01T19:00:00Z',
          shippedAt: '2026-09-03T19:00:00Z',
          status: 'Shipped',
          currency: 'USD',
          amount: 10,
        })
        await insertRow(client, 'Order', { id: 'o2', ...store, amazonOrderId: 'U-2', purchaseDate: '2026-08-20T19:00:00Z', status: 'Shipped', currency: 'USD', amount: 10 })
        await insertRow(client, 'Order', { id: 'o2b', ...store, amazonOrderId: 'U-2', purchaseDate: '2026-08-10T19:00:00Z', status: 'Shipped', currency: 'USD', amount: 10 })
        await returned('r1', 'U-1')
        await returned('r2', 'U-2')
        await returned('r3', 'U-NO-ORDER')

        await applyMigrations(client, { only: TARGET })
        const dates = async () =>
          Object.fromEntries(
            (
              await client.query(
                `SELECT id, to_char("orderPurchasedAt", 'YYYY-MM-DD HH24:MI') AS purchased, to_char("orderShippedAt", 'YYYY-MM-DD HH24:MI') AS shipped FROM "FbaReturnCase" ORDER BY id`,
              )
            ).rows.map(row => [row.id, [row.purchased, row.shipped]]),
          )
        expect(await dates()).toEqual({
          r1: ['2026-09-01 19:00', '2026-09-03 19:00'],
          r2: ['2026-08-10 19:00', null],
          r3: [null, null],
        })
        await insertRow(client, 'ReturnReasonMap', { tenantId: ids.tenantId, code: 'X', labelZh: '甲', category: '兼容性' })
        await expect(insertRow(client, 'ReturnReasonMap', { tenantId: ids.tenantId, code: 'Y', labelZh: '', category: '兼容性' })).rejects.toThrow(/ReturnReasonMap_check/)

        await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
        const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'FbaReturnCase' AND column_name IN ('orderPurchasedAt', 'orderShippedAt')`)).rows
        expect(columns).toEqual([])
        expect((await client.query(`SELECT to_regclass('"ReturnReasonMap"') AS name`)).rows[0].name).toBeNull()
        expect((await client.query(`SELECT count(*)::int AS n FROM "FbaReturnCase"`)).rows[0].n).toBe(3)

        await applyMigrations(client, { only: TARGET })
        expect((await dates()).r1).toEqual(['2026-09-01 19:00', '2026-09-03 19:00'])
      } finally {
        await client.end()
      }
    })
  })

  describe('接口', () => {
    let h: DbTestApp
    let a: Awaited<ReturnType<DbTestApp['createTenant']>>
    let b: Awaited<ReturnType<DbTestApp['createTenant']>>
    let reader: { token: string }
    let writer: { token: string }
    let scoped: { token: string }
    let other: { token: string }
    let otherWriter: { token: string }
    let noPermission: { token: string }

    const get = (token: string | null, path: string) => h.call(token, 'GET', path)
    const put = (token: string | null, items: unknown[]) => h.call(token, 'PUT', '/returns/reason-map', { body: { items } })
    const analysis = (name: string, query = RANGE, token = reader.token) => get(token, `/returns/analysis/${name}?${query}`).then(res => res.json.data)

    const returned = (id: string, no: string, returnDate: string, orderAt: string | null, extra: Record<string, unknown> = {}) =>
      insertRow(h.client, 'FbaReturnCase', {
        id,
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        amazonOrderId: no,
        asin: 'B000000001',
        sellerSku: 'SKU-1',
        quantity: 1,
        returnDate,
        orderPurchasedAt: orderAt,
        ...extra,
      })
    const orderRow = (id: string, no: string, amount: number) =>
      insertRow(h.client, 'Order', {
        id,
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        amazonOrderId: no,
        purchaseDate: '2026-08-20T19:00:00Z',
        status: 'Shipped',
        currency: 'USD',
        amount,
      })
    const refund = (id: string, no: string, amount: number) =>
      insertRow(h.client, 'FbaFinancialTransaction', {
        id,
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        externalTransactionId: id,
        amazonOrderId: no,
        transactionType: 'Refund',
        transactionStatus: 'RELEASED',
        amount: -amount,
        postedAt: '2026-09-06T19:00:00Z',
      })
    const sold = (id: string, day: string, units: number) =>
      insertRow(h.client, 'AsinDailySummary', { id, tenantId: a.tenantId, sellerAccountId: a.sellerAccountId, summaryDate: day, asin: 'B000000001', units, metricVersion: 'v1' })

    beforeAll(async () => {
      h = await createDbTestApp({ database: 'return_analysis_api', db })
      a = await h.createTenant('a')
      b = await h.createTenant('b')
      await insertRow(h.client, 'SellerAccount', { id: 'seller-a2', tenantId: a.tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2' })
      reader = await h.createMember(a.tenantId, 'reader', ['returns.read'])
      writer = await h.createMember(a.tenantId, 'writer', ['returns.read', 'settings.write'])
      scoped = await h.createMember(a.tenantId, 'scoped', ['returns.read'], { scopes: [{ sellerAccountId: 'seller-a2' }] })
      noPermission = await h.createMember(a.tenantId, 'nop', ['member.read'])
      other = await h.createMember(b.tenantId, 'other', ['returns.read'])
      otherWriter = await h.createMember(b.tenantId, 'otherw', ['returns.read', 'settings.write'])

      // c1 跨月：8-20 下单（8-22 发货），9-05 退 2 件；c2 同月：9-01 下单（9-04 发货），9-10 退 1 件；c3 跨年：2025-12-28 下单，2026-01-03 退
      // c4 同一天：9-12 下单并退 3 件；c5 缺下单时间：9-15 退 4 件（原因代码预置里没有）；c6 月边界：9-15 下单，10-01 03:00 UTC（洛杉矶 9-30）退
      // c7 起点晚于退货（数据异常）：9-20 下单，9-18 退
      const base = { disposition: 'SELLABLE', reportStatus: 'Unit returned to inventory' }
      await returned('c1', 'C1', '2026-09-05T19:00:00Z', '2026-08-20T19:00:00Z', { ...base, quantity: 2, reason: 'DEFECTIVE', orderShippedAt: '2026-08-22T19:00:00Z' })
      await returned('c2', 'C2', '2026-09-10T19:00:00Z', '2026-09-01T19:00:00Z', {
        asin: 'B000000002',
        disposition: 'DAMAGED',
        reportStatus: 'Reimbursed',
        reason: 'NOT_AS_DESCRIBED',
        orderShippedAt: '2026-09-04T19:00:00Z',
      })
      await returned('c3', 'C3', '2026-01-03T19:00:00Z', '2025-12-28T19:00:00Z', { reason: 'WRONG_ITEM', disposition: null, reportStatus: null })
      await returned('c4', 'C4', '2026-09-12T21:00:00Z', '2026-09-12T19:00:00Z', { ...base, quantity: 3, reason: 'UNWANTED_ITEM' })
      await returned('c5', 'C5', '2026-09-15T19:00:00Z', null, { quantity: 4, reason: 'brand_new', disposition: 'DEFECTIVE', reportStatus: 'Reimbursed' })
      await returned('c6', 'C6', '2026-10-01T03:00:00Z', '2026-09-15T19:00:00Z', { reason: 'DEFECTIVE', disposition: 'SELLABLE', reportStatus: null })
      await returned('c7', 'C7', '2026-09-18T19:00:00Z', '2026-09-20T19:00:00Z', { ...base, reason: null })
      // 另一个店铺（数据范围）与另一个租户
      await insertRow(h.client, 'FbaReturnCase', {
        id: 'c8',
        tenantId: a.tenantId,
        sellerAccountId: 'seller-a2',
        amazonOrderId: 'C8',
        asin: 'B000000003',
        sellerSku: 'SKU-3',
        quantity: 5,
        returnDate: '2026-09-02T19:00:00Z',
        orderPurchasedAt: '2026-08-30T19:00:00Z',
        reason: 'ARRIVED_LATE',
      })
      await insertRow(h.client, 'FbaReturnCase', {
        id: 'cb',
        tenantId: b.tenantId,
        sellerAccountId: b.sellerAccountId,
        amazonOrderId: 'CB',
        asin: 'B000000009',
        sellerSku: 'SKU-9',
        quantity: 9,
        returnDate: '2026-09-02T19:00:00Z',
        orderPurchasedAt: '2026-08-30T19:00:00Z',
      })

      // 退款：C1 跨月订单退 60，C2 同月订单退 40（订单金额与退款一致）；C3 等订单没有财务数据
      await orderRow('o-C1', 'C1', 60)
      await refund('t-C1', 'C1', 60)
      await orderRow('o-C2', 'C2', 40)
      await refund('t-C2', 'C2', 40)
      // 销售件数（按下单日）：8 月 40，9 月 60
      await sold('s1', '2026-08-20', 40)
      await sold('s2', '2026-09-01', 10)
      await sold('s3', '2026-09-12', 20)
      await sold('s4', '2026-09-15', 30)
    })
    afterAll(async () => {
      await h?.close()
    })

    describe('原因映射', () => {
      it('列表含 22 个预置原因（三层：代码、中文、大类），没有写权限时说明原因；别的租户互不影响', async () => {
        const res = await get(reader.token, '/returns/reason-map?pageSize=100')
        expect(res.status).toBe(200)
        expect(res.json.data.total).toBe(22)
        expect(res.json.data.canManage).toBe(false)
        expect(res.json.data.manageBlockedReason).toContain('权限')
        expect(res.json.data.items.find((row: { code: string }) => row.code === 'DEFECTIVE')).toMatchObject({ labelZh: '商品有缺陷', category: '商品质量', source: 'PRESET', updatedAt: null })
        expect((await get(writer.token, '/returns/reason-map')).json.data.canManage).toBe(true)
        expect((await get(noPermission.token, '/returns/reason-map')).status).toBe(403)
        expect((await get(null, '/returns/reason-map')).status).toBe(401)
      })

      it('筛选：大类、关键字（代码或中文）；排序与分页', async () => {
        const quality = (await get(reader.token, '/returns/reason-map?category=商品质量&pageSize=100')).json.data
        expect(quality.items.map((row: { code: string }) => row.code).sort()).toEqual(['DEFECTIVE', 'QUALITY_UNACCEPTABLE'])
        expect((await get(reader.token, `/returns/reason-map?q=${encodeURIComponent('缺陷')}`)).json.data.items[0].code).toBe('DEFECTIVE')
        expect((await get(reader.token, '/returns/reason-map?q=arrived')).json.data.items.map((row: { code: string }) => row.code)).toEqual(['ARRIVED_LATE'])
        const page = (await get(reader.token, '/returns/reason-map?pageSize=10&page=3&sort=code:asc')).json.data
        expect(page.items).toHaveLength(2)
        expect(page.total).toBe(22)
      })

      it('保存需要 settings.write：只读成员 403；新增新代码（转大写）与修改预置项；预置项保留出厂值以便对照；写审计', async () => {
        expect((await put(reader.token, [{ code: 'x', labelZh: '甲', category: '兼容性' }])).status).toBe(403)
        const res = await put(writer.token, [
          { code: 'custom_reason', labelZh: '全新原因', category: '兼容性' },
          { code: 'DEFECTIVE', labelZh: '做工问题', category: '其他原因' },
        ])
        expect(res.status).toBe(200)
        expect(res.json.data.saved).toBe(2)
        const rows = Object.fromEntries(res.json.data.items.map((row: { code: string }) => [row.code, row]))
        expect(rows.CUSTOM_REASON).toMatchObject({ labelZh: '全新原因', category: '兼容性', source: 'CUSTOM', presetLabelZh: null, unclassified: false })
        expect(rows.DEFECTIVE).toMatchObject({ labelZh: '做工问题', category: '其他原因', source: 'PRESET_EDITED', presetLabelZh: '商品有缺陷', presetCategory: '商品质量' })
        const list = (await get(reader.token, '/returns/reason-map?pageSize=100')).json.data
        expect(list.total).toBe(23)
        expect(list.summary).toMatchObject({ total: 23, edited: 1, custom: 1, unclassified: 0 })
        const audit = await h.client.query(`SELECT "resourceType", "detail" FROM "AuditEvent" WHERE "action" = 'RETURN_REASON_MAP_UPDATED' AND "result" = 'SUCCEEDED' AND "tenantId" = $1`, [
          a.tenantId,
        ])
        expect(audit.rows).toHaveLength(1)
        expect(audit.rows[0].detail.count).toBe(2)
        expect(audit.rows[0].detail.changes).toBeDefined()
        // 别的租户看不到这两条
        const mine = (await get(other.token, '/returns/reason-map?pageSize=100')).json.data
        expect(mine.total).toBe(22)
        expect(mine.items.find((row: { code: string }) => row.code === 'DEFECTIVE')).toMatchObject({ labelZh: '商品有缺陷', source: 'PRESET' })
        // 再改回去：再次保存同一代码是覆盖，不是新增
        expect((await put(writer.token, [{ code: 'DEFECTIVE', labelZh: '商品有缺陷', category: '商品质量' }])).status).toBe(200)
        expect((await get(reader.token, '/returns/reason-map?pageSize=100')).json.data.total).toBe(23)
      })

      it('改过的映射马上体现在退货列表与详情的原因三层上', async () => {
        await put(writer.token, [{ code: 'DEFECTIVE', labelZh: '做工问题', category: '其他原因' }])
        const list = (await get(reader.token, `/returns?${RANGE}&pageSize=50&q=C1`)).json.data
        expect(list.items[0]).toMatchObject({ reason: 'DEFECTIVE', reasonLabel: '做工问题', reasonCategory: '其他原因' })
        const detail = (await get(reader.token, '/returns/c1')).json.data
        expect(detail.reason).toEqual({ code: 'DEFECTIVE', label: '做工问题', category: '其他原因' })
        // 没有原因的退货三项都为空；预置里没有的代码按原样显示并标“未分类”
        const none = (await get(reader.token, '/returns/c7')).json.data
        expect(none.reason).toEqual({ code: null, label: null, category: null })
        expect((await get(reader.token, '/returns/c5')).json.data.reason).toEqual({ code: 'brand_new', label: 'brand_new', category: '未分类' })
        await put(writer.token, [{ code: 'DEFECTIVE', labelZh: '商品有缺陷', category: '商品质量' }])
      })

      it('企业映射上限 500 行：满了再新增 409，覆盖已有的不受影响', async () => {
        const values = Array.from({ length: 498 }, (_, index) => `('fill_${index}', '${b.tenantId}', 'FILL_${index}', '填充${index}', '其他原因', false, now(), now())`).join(',')
        await h.client.query(`INSERT INTO "ReturnReasonMap" ("id", "tenantId", "code", "labelZh", "category", "isSystem", "createdAt", "updatedAt") VALUES ${values}`)
        expect(
          (
            await put(otherWriter.token, [
              { code: 'NEW_1', labelZh: '甲', category: '兼容性' },
              { code: 'NEW_2', labelZh: '乙', category: '兼容性' },
            ])
          ).status,
        ).toBe(200)
        const full = await put(otherWriter.token, [{ code: 'NEW_3', labelZh: '丙', category: '兼容性' }])
        expect(full.status).toBe(409)
        expect(full.json.error.message).toContain('500')
        expect((await put(otherWriter.token, [{ code: 'NEW_1', labelZh: '甲改', category: '兼容性' }])).status).toBe(200)
      })
    })

    describe('概览（M-700、M-701）', () => {
      it('按退货时间：总数、三层原因（代码、中文、大类）、未分类提醒、大类汇总、处置分布；退货率分母是销售件数，没有汇总的月份为空', async () => {
        const data = await analysis('summary')
        expect(data).toMatchObject({ state: 'OK', timeBasis: 'return', range: { from: '2026-01-01', to: '2026-09-30', defaulted: false } })
        // 退货总件数：c1 2 + c2 1 + c3 1 + c4 3 + c5 4 + c6 1 + c7 1 = 13（c8 是别的店铺，但范围是整个租户，所以 +5 = 18）
        expect(data.totals).toEqual({ returnedUnits: 18, soldUnits: 100, rate: 0.18 })
        const reasons = Object.fromEntries(data.byReason.map((row: { code: string }) => [row.code, row]))
        expect(reasons.DEFECTIVE).toMatchObject({ units: 3, label: '商品有缺陷', category: '商品质量', unclassified: false })
        expect(reasons.BRAND_NEW).toMatchObject({ units: 4, label: 'BRAND_NEW', category: '未分类', unclassified: true })
        expect(reasons.UNSPECIFIED).toMatchObject({ units: 1, label: '未提供原因' })
        expect(data.unclassified).toEqual({ codes: ['BRAND_NEW'], units: 4 })
        const categories = Object.fromEntries(data.byCategory.map((row: { category: string; units: number }) => [row.category, row.units]))
        expect(categories).toMatchObject({ 商品质量: 3, 与描述不符: 1, 缺件与错发: 1, 买家改变主意: 3, 物流与配送: 5, 未分类: 5 })
        expect(data.byCategory.reduce((sum: number, row: { share: number }) => sum + row.share, 0)).toBeCloseTo(1, 2)
        const dispositions = Object.fromEntries(data.byDisposition.map((row: { group: string; units: number }) => [row.group, row.units]))
        expect(dispositions).toMatchObject({ SELLABLE: 7, DAMAGED: 1, DEFECTIVE: 4, UNKNOWN: 6 })
        expect(data.unknownOrderUnits).toBe(4)
        expect(data.unknownOrderRows).toBe(1)
        expect(data.basis).toContain('M-704')
        expect(data.ranks.periods.map((row: { key: string }) => row.key)).toEqual(['current', 'previous', 'beforePrevious'])
      })

      it('按下单时间：只统计能确定下单时间的退货，下单早于范围的（c3）不在内；缺下单时间的另计，不丢也不并入', async () => {
        const data = await analysis('summary', `${RANGE}&timeBasis=order`)
        expect(data.timeBasis).toBe('order')
        // c1 2 + c2 1 + c4 3 + c6 1 + c7 1 + c8 5 = 13
        expect(data.totals.returnedUnits).toBe(13)
        expect(data.unknownOrderUnits).toBe(4)
        expect(data.unknownOrderRows).toBe(1)
        expect(data.byReason.some((row: { code: string }) => row.code === 'BRAND_NEW')).toBe(false)
      })

      it('异常榜与改善榜：三期等长对比，件数太少的不入榜；数据范围与租户隔离', async () => {
        const data = await analysis('summary', 'from=2026-09-01&to=2026-09-30')
        // 本期（9 月）B000000001 退 c1 2 + c4 3 + c5 4 + c6 1 + c7 1 = 11 件，上期（8 月）0 件
        expect(data.ranks.anomalies[0]).toMatchObject({ asin: 'B000000001', current: 11, previous: 0, delta: 11, streak: false })
        expect(data.ranks.improvements).toEqual([])
        const scopedData = await analysis('summary', RANGE, scoped.token)
        expect(scopedData.totals.returnedUnits).toBe(5)
        expect(scopedData.byAsin.map((row: { asin: string }) => row.asin)).toEqual(['B000000003'])
        const mine = await analysis('summary', RANGE, other.token)
        expect(mine.totals.returnedUnits).toBe(9)
        expect(mine.byAsin.map((row: { asin: string }) => row.asin)).toEqual(['B000000009'])
      })

      it('范围内没有退货：NO_DATA 并说明；没有权限 403；参数错 422', async () => {
        const empty = await analysis('summary', 'from=2024-01-01&to=2024-02-01')
        expect(empty).toMatchObject({ state: 'NO_DATA', byAsin: [], byReason: [], byCategory: [] })
        expect(empty.totals.rate).toBeNull()
        expect(empty.note).toContain('尚无退货记录')
        expect((await get(noPermission.token, `/returns/analysis/summary?${RANGE}`)).status).toBe(403)
        expect((await get(reader.token, `/returns/analysis/summary?${RANGE}&timeBasis=ship`)).status).toBe(422)
      })
    })

    describe('退货周期', () => {
      it('按下单日期：同一天是 0 天；中位数按件数加权；缺下单时间与起点晚于退货的单独计数（不当 0 天）', async () => {
        const data = await analysis('cycle', `${RANGE}&anchor=order`)
        // 可计算：c1 16 天×2、c2 9 天、c3 6 天（跨年）、c4 0 天×3（同一天）、c6 15 天（洛杉矶 9-15 到 9-30）、c8 3 天×5；c5 缺下单时间、c7 起点晚于退货，不参与
        expect(data.totals.units).toBe(2 + 1 + 1 + 3 + 1 + 5)
        expect(data.buckets.map((row: { units: number }) => row.units)).toEqual([4 + 5, 1, 3, 0, 0, 0])
        expect(data.buckets.reduce((sum: number, row: { units: number }) => sum + row.units, 0)).toBe(data.totals.units)
        expect(data.unknownOrderUnits).toBe(5)
        expect(data.unknownOrderRows).toBe(2)
        expect(data.bounds).toEqual([7, 14, 30, 60, 90])
        expect(data.buckets[0]).toMatchObject({ label: '0–7 天', min: 0, max: 7 })
      })

      it('发货日期起点：只有有发货时间的参与，其余计入“无法计算周期”', async () => {
        const data = await analysis('cycle', `${RANGE}&anchor=ship`, scoped.token)
        expect(data.totals.units).toBe(0)
        expect(data.unknownOrderRows).toBe(1)
        const main = await analysis('cycle', `${RANGE}&anchor=ship`)
        // c1：8-22 发货 → 9-05 退 = 14 天（2 件）；c2：9-04 → 9-10 = 6 天（1 件）
        expect(main.totals.units).toBe(3)
        expect(main.buckets.map((row: { units: number }) => row.units)).toEqual([1, 2, 0, 0, 0, 0])
        expect(main.totals.median).toBe(14)
        expect(main.anchor).toBe('ship')
      })

      it('自定义天数段只用一套；写错 422；按原因切片，每个切片自己的中位数', async () => {
        const data = await analysis('cycle', `${RANGE}&bounds=5,10,20&dimension=reason`)
        expect(data.bounds).toEqual([5, 10, 20])
        expect(data.buckets.map((row: { label: string }) => row.label)).toEqual(['0–5 天', '6–10 天', '11–20 天', '20 天以上'])
        const slices = Object.fromEntries(data.slices.map((row: { key: string }) => [row.key, row]))
        expect(slices.DEFECTIVE).toMatchObject({ units: 3, median: 16 })
        expect(slices.UNWANTED_ITEM).toMatchObject({ units: 3, median: 0 })
        expect(slices.BRAND_NEW).toBeUndefined()
        expect((await get(reader.token, `/returns/analysis/cycle?${RANGE}&bounds=10,5`)).status).toBe(422)
      })

      it('按下单时间统计：缺下单时间的退货也计入无法计算周期（不在下单口径范围内也要数出来）', async () => {
        const data = await analysis('cycle', `${RANGE}&timeBasis=order`)
        expect(data.timeBasis).toBe('order')
        expect(data.unknownOrderRows).toBe(2)
        expect(data.unknownOrderUnits).toBe(5)
      })
    })

    describe('跨月退货（M-702）', () => {
      it('下单月与退货月不同的占比；月份边界按企业时区（洛杉矶 9-30 晚上的退货算 9 月）；跨年算跨月；缺下单时间不进分子分母', async () => {
        const data = await analysis('cross-month')
        // 可计算：c1 2（跨月）、c2 1、c3 1（跨年，跨月）、c4 3、c6 1、c7 1、c8 5（8-30 下单、9-02 退，跨月）
        expect(data.totals).toEqual({ computableUnits: 14, crossMonthUnits: 8, share: 0.5714 })
        expect(data.unknownOrderUnits).toBe(4)
        expect(data.unknownOrderRows).toBe(1)
        const { matrix } = data
        expect(matrix.orderMonths).toEqual(['2025-12', '2026-08', '2026-09'])
        expect(matrix.returnMonths).toEqual(['2026-01', '2026-09'])
        expect(matrix.cells).toEqual([
          [1, 0],
          [0, 7],
          [0, 6],
        ])
        expect(matrix.hiddenUnits).toBe(0)
      })

      it('跨月退货的退款金额占比：订单口径，同一订单只算一次；没有财务数据的订单不进分母', async () => {
        const { refund } = await analysis('cross-month')
        // 有退款金额的订单：C1（跨月，60）、C2（同月，40）；C3、C4、C6、C7、C8 没有订单与财务交易
        expect(refund).toMatchObject({ state: 'OK', currency: 'USD', crossMonthAmount: 60, totalAmount: 100, share: 0.6, sampledOrders: 7 })
      })

      it('按下单时间统计：c3（下单早于范围）不在内；数据范围外的店铺看不到', async () => {
        const data = await analysis('cross-month', `${RANGE}&timeBasis=order`)
        expect(data.totals.computableUnits).toBe(13)
        const scopedData = await analysis('cross-month', RANGE, scoped.token)
        expect(scopedData.totals).toEqual({ computableUnits: 5, crossMonthUnits: 5, share: 1 })
        expect(scopedData.refund.state).toBe('NO_DATA')
      })
    })

    describe('队列退货率（M-703）', () => {
      it('按下单月：同一批订单的退货 ÷ 同月销售件数；与按退货日的退货率并排；没有销售汇总的月份为空', async () => {
        const data = await analysis('cohort')
        expect(data.timeBasis).toBe('order')
        expect(data.months).toHaveLength(9)
        const rows = Object.fromEntries(data.months.map((row: { month: string }) => [row.month, row]))
        // 8 月：c1 2 + c8 5 = 7 件 ÷ 销售 40；9 月：c2 1 + c4 3 + c6 1 + c7 1 = 6 件 ÷ 销售 60；按退货日：9 月 c1 2 + c2 1 + c4 3 + c5 4 + c6 1 + c7 1 + c8 5 = 17
        expect(rows['2026-08']).toMatchObject({ soldUnits: 40, cohortReturnedUnits: 7, cohortRate: 0.175, returnedInMonthUnits: 0 })
        expect(rows['2026-09']).toMatchObject({ soldUnits: 60, cohortReturnedUnits: 6, cohortRate: 0.1, returnedInMonthUnits: 17, returnDateRate: 0.2833 })
        expect(rows['2026-01']).toMatchObject({ soldUnits: null, cohortReturnedUnits: 0, cohortRate: null, returnedInMonthUnits: 1, returnDateRate: null })
        expect(data.unknownOrderUnits).toBe(4)
        expect(data.basis).toContain('M-703')
      })

      it('只覆盖日期范围里的整月；范围里没有退货时 NO_DATA', async () => {
        const data = await analysis('cohort', 'from=2026-08-15&to=2026-09-10')
        expect(data.months.map((row: { month: string }) => row.month)).toEqual(['2026-08', '2026-09'])
        expect((await analysis('cohort', 'from=2024-01-01&to=2024-02-01')).state).toBe('NO_DATA')
        expect((await get(noPermission.token, `/returns/analysis/cohort?${RANGE}`)).status).toBe(403)
      })
    })

    describe('库存属性 × 处置结果', () => {
      it('行是处置分组，列是报告处理状态原文（最多 8 种）；缺处理状态的是“未提供”；格内合计等于总数', async () => {
        const data = await analysis('disposition-matrix', RANGE, scoped.token)
        expect(data.totals.units).toBe(5)
        const full = await analysis('disposition-matrix')
        expect(full.rows.map((row: { key: string }) => row.key)).toEqual(['SELLABLE', 'DAMAGED', 'DEFECTIVE', 'UNKNOWN'])
        expect(full.columns.map((row: { label: string }) => row.label)).toEqual(['Unit returned to inventory', 'Reimbursed', '未提供'])
        const flat = (full.cells as number[][]).flat().reduce((sum, value) => sum + value, 0)
        expect(flat).toBe(full.totals.units)
        expect(full.totals.units).toBe(18)
        const sellable = full.cells[full.rows.findIndex((row: { key: string }) => row.key === 'SELLABLE')]
        expect(sellable).toEqual([6, 0, 1])
        expect(full.basis).toContain('库存属性')
      })
    })
  })
})
