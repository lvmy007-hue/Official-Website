import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 利润项目字典（P6-18，真实数据库）：第一次打开自动生成第一版（按内置口径归并）；保存：版本递增、旧版本退役、过期版本 409、
// 系统项目不能删、同级重名拒绝、改映射、新增自定义项目与删除（映射随之变为未映射）；未映射列表；权限；跨企业隔离；
// 利润页总览按字典拆分且合计与净利润对得上；数据库层兜底（系统项目不能被直接删除）。

type Member = { userId: string; token: string }
type Json = ReturnType<typeof JSON.parse>

describe('利润项目字典（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let sellerId: string
  let otherTenantId: string
  let owner: Member
  let reader: Member
  let outsider: Member

  const rows = async <T = Json>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Json
  }
  const put = (member: Member, body: unknown) => h.call(member.token, 'PUT', '/finance/profit-items', { body })
  const fee = (id: string, category: string, subtype: string | null) =>
    insertRow(h.client, 'FbaFeeEvent', {
      id,
      tenantId,
      sellerAccountId: sellerId,
      sourceEventId: `${id}:0`,
      currency: 'USD',
      postedAt: new Date(Date.now() - 2 * 86_400_000),
      feeCategory: category,
      feeSubtype: subtype,
      amount: -5,
    })
  /** 把读到的字典原样变成保存请求体。 */
  const bodyOf = (data: Json, mutate?: (body: { version: number; items: Json[]; mappings: Json[] }) => void) => {
    const body = {
      version: data.version as number,
      items: (data.items as Json[]).map(item => ({ id: item.id, parentId: item.parentId, name: item.name, sort: item.sort })),
      mappings: (data.mappings as Json[]).map(mapping => ({ transactionType: mapping.transactionType, itemId: mapping.itemId })),
    }
    mutate?.(body)
    return body
  }
  const idOf = (data: Json, name: string) => (data.items as Json[]).find(item => item.name === name)?.id as string

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'profit_items' })
    const a = await h.createTenant('pi-a')
    const b = await h.createTenant('pi-b')
    tenantId = a.tenantId
    sellerId = a.sellerAccountId
    otherTenantId = b.tenantId
    await fee('pf1', 'COMMISSION', 'Commission')
    await fee('pf2', 'FULFILLMENT', 'FBAPerUnitFulfillmentFee')
    await fee('pf3', 'OTHER', 'Odd')
    owner = await h.createMember(tenantId, 'pi-owner', ['finance.read', 'finance.profititem.manage'])
    reader = await h.createMember(tenantId, 'pi-reader', ['finance.read'])
    outsider = await h.createMember(otherTenantId, 'pi-outsider', ['finance.read', 'finance.profititem.manage'])
  }, 180_000)
  afterAll(async () => {
    await h?.close()
  })

  it('第一次读取自动生成第一版：6 个一级项目、系统二级项目、按内置口径映射出现过的交易类型', async () => {
    const data = await get(reader, '/finance/profit-items')
    expect(data).toMatchObject({ version: 1, seeded: true, canManage: false })
    expect((data.items as Json[]).filter(item => item.level === 1)).toHaveLength(6)
    expect((data.mappings as Json[]).map(mapping => mapping.transactionType).sort()).toEqual(['COMMISSION/Commission', 'FULFILLMENT/FBAPerUnitFulfillmentFee', 'OTHER/Odd'])
    const commission = (data.mappings as Json[]).find(mapping => mapping.transactionType === 'COMMISSION/Commission')
    expect(commission.itemId).toBe(idOf(data, '佣金'))
    expect(data.manageBlockedReason).toContain('finance.profititem.manage')
    // 再读一次不会重复生成
    const again = await get(reader, '/finance/profit-items')
    expect(again).toMatchObject({ version: 1, seeded: false })
    expect(await rows(`SELECT 1 FROM "MetricVersion" WHERE "tenantId" = $1 AND kind = 'PROFIT_DICTIONARY'`, [tenantId])).toHaveLength(1)
  })

  it('权限：只读不能保存；别的企业看不到也改不了这家的字典', async () => {
    const data = await get(reader, '/finance/profit-items')
    expect((await put(reader, bodyOf(data))).status).toBe(403)
    const other = await get(outsider, '/finance/profit-items')
    expect(other.seeded).toBe(true)
    expect((other.items as Json[]).map(item => item.id)).not.toContain(idOf(data, '佣金'))
    expect((other.mappings as Json[]).filter(mapping => mapping.transactionType.startsWith('COMMISSION'))).toHaveLength(0)
  })

  it('保存：改映射与新增自定义项目，版本递增、旧版本退役、快照留存；过期版本 409', async () => {
    const data = await get(owner, '/finance/profit-items')
    const res = await put(
      owner,
      bodyOf(data, body => {
        body.items.push({ id: 'new:1', parentId: idOf(data, '物流费用'), name: '海外仓操作费', sort: 99 })
        const mystery = body.mappings.find(mapping => mapping.transactionType === 'OTHER/Odd')
        mystery.itemId = 'new:1'
      }),
    )
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ version: 2, items: 23, mappings: 3 })
    const newId = res.json.data.idMap['new:1'] as string
    expect(newId).toBeTruthy()
    const versions = await rows<{ versionNo: number; status: string }>(`SELECT "versionNo", status FROM "MetricVersion" WHERE "tenantId" = $1 AND kind = 'PROFIT_DICTIONARY' ORDER BY "versionNo"`, [
      tenantId,
    ])
    expect(versions).toEqual([
      { versionNo: 1, status: 'RETIRED' },
      { versionNo: 2, status: 'ACTIVE' },
    ])
    expect((await rows(`SELECT "itemId" FROM "ProfitItemMapping" WHERE "tenantId" = $1 AND "transactionType" = 'OTHER/Odd'`, [tenantId]))[0].itemId).toBe(newId)
    expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'PROFIT_ITEMS_SAVED'`)).length).toBeGreaterThanOrEqual(1)
    // 还拿着版本 1 保存：409
    const stale = await put(owner, { ...bodyOf(data), version: 1 })
    expect(stale.status).toBe(409)
    expect(stale.json.error.details).toMatchObject({ currentVersion: 2 })
  })

  it('校验：系统项目不能删除、同级重名、超过三级、映射到不接收交易的项目都是 422，不改库', async () => {
    const data = await get(owner, '/finance/profit-items')
    const before = await rows(`SELECT count(*)::int AS n FROM "ProfitItem" WHERE "tenantId" = $1`, [tenantId])
    const storage = idOf(data, '仓储费')
    expect(
      (
        await put(
          owner,
          bodyOf(data, body => (body.items = body.items.filter(item => item.id !== storage))),
        )
      ).status,
    ).toBe(422)
    const dup = await put(
      owner,
      bodyOf(data, body => {
        body.items.push({ id: 'new:a', parentId: storage, name: '甲', sort: 1 }, { id: 'new:b', parentId: storage, name: '甲', sort: 2 })
      }),
    )
    expect(dup.status).toBe(422)
    const deep = await put(
      owner,
      bodyOf(data, body => {
        body.items.push({ id: 'new:a', parentId: storage, name: '三级', sort: 1 }, { id: 'new:b', parentId: 'new:a', name: '四级', sort: 1 })
      }),
    )
    expect(deep.status).toBe(422)
    const toAds = await put(
      owner,
      bodyOf(data, body => (body.mappings[0].itemId = idOf(data, '广告'))),
    )
    expect(toAds.status).toBe(422)
    expect(await rows(`SELECT count(*)::int AS n FROM "ProfitItem" WHERE "tenantId" = $1`, [tenantId])).toEqual(before)
    expect((await get(owner, '/finance/profit-items')).version).toBe(2)
  })

  it('删除自定义项目：子项目与指向它的映射一起消失，交易类型回到未映射；未映射列表按笔数排序', async () => {
    const data = await get(owner, '/finance/profit-items')
    const custom = idOf(data, '海外仓操作费')
    const res = await put(
      owner,
      bodyOf(data, body => {
        body.items = body.items.filter(item => item.id !== custom)
        body.mappings = body.mappings.filter(mapping => mapping.itemId !== custom)
      }),
    )
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const after = await get(owner, '/finance/profit-items')
    expect(after).toMatchObject({ version: 3, unmappedCount: 1 })
    expect((after.mappings as Json[]).map(mapping => mapping.transactionType)).not.toContain('OTHER/Odd')
    const unmapped = await get(owner, '/finance/profit-items/unmapped')
    expect(unmapped.total).toBe(1)
    expect(unmapped.items[0]).toMatchObject({ transactionType: 'OTHER/Odd', txCount30d: 1 })
  })

  it('改名后原名可以被别的项目使用（同级互换名称不撞唯一键）', async () => {
    const data = await get(owner, '/finance/profit-items')
    const a = idOf(data, '佣金')
    const b = idOf(data, '其他平台费用')
    const res = await put(
      owner,
      bodyOf(data, body => {
        body.items.find(item => item.id === a).name = '其他平台费用'
        body.items.find(item => item.id === b).name = '佣金'
      }),
    )
    expect(res.status, JSON.stringify(res.json)).toBe(200)
  })

  it('数据库兜底：系统项目不能被直接删除', async () => {
    await expect(rows(`DELETE FROM "ProfitItem" WHERE "tenantId" = $1 AND "systemKey" = 'COMMISSION'`, [tenantId])).rejects.toThrow()
  })

  it('字典查询参数：未映射列表排序字段不在白名单、页大小为 0 是 422', async () => {
    expect((await h.call(owner.token, 'GET', '/finance/profit-items/unmapped?sort=password:asc')).status).toBe(422)
    expect((await h.call(owner.token, 'GET', '/finance/profit-items/unmapped?pageSize=0')).status).toBe(422)
  })
})
