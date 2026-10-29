import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告账户与店铺绑定（P3-03，真实数据库 + 完整应用 + worker 的自动匹配代码）：
// 自动匹配只在本企业内按卖家编号找唯一店铺；绑定清单与未绑定原因；人工绑定、改绑（要原因）、固定、解除与审计；
// 验收：广告数据（活动、日指标）跟着“广告账户绑定的店铺”参与数据范围过滤——改绑后看得到的人跟着变，未绑定只有全部范围的人看得到；
// 人工绑定永不被自动匹配覆盖；别的企业的广告账户与店铺碰不到。

type Member = { userId: string; token: string }
type AutoBind = (db: unknown, profile: Record<string, unknown>) => Promise<string>

const DAY = '2026-10-10T00:00:00.000Z'

describe('广告账户与店铺绑定（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let autoBind: AutoBind
  let tenantId: string
  let storeA: string
  let storeA2: string
  let otherTenantId: string
  let admin: Member
  let reader: Member
  let scopedA: Member
  let scopedA2: Member
  let scopedAWithBind: Member
  let otherAdmin: Member

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const profileRow = async (id: string) =>
    (await rows<{ sellerAccountId: string | null; bindingStatus: string; boundBy: string | null }>(`SELECT "sellerAccountId", "bindingStatus", "boundBy" FROM "AdsProfile" WHERE id = $1`, [id]))[0]
  const list = async (member: Member) => {
    const res = await h.call(member.token, 'GET', '/connections/ads-accounts')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json.data as {
      items: { id: string; bindingStatus: string; unboundReason: string | null; candidateCount: number; store: { id: string } | null }[]
      summary: Record<string, number>
      canBind: boolean
      stores: unknown[]
    }
  }
  const ids = async (member: Member) => (await list(member)).items.map(item => item.id).sort()
  const campaigns = async (member: Member) => {
    const res = await h.call(member.token, 'GET', '/ads/campaigns')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return (res.json.data.items as { externalCampaignId: string }[]).map(item => item.externalCampaignId).sort()
  }
  const metrics = async (member: Member) => {
    const res = await h.call(member.token, 'GET', '/ads/metrics?dims=campaign&metrics=spend&from=2026-10-10&to=2026-10-10')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return (res.json.data.items as { key: string }[]).map(item => item.key).sort()
  }
  const bind = (member: Member, profileId: string, body: Record<string, unknown>) => h.call(member.token, 'POST', `/connections/ads-accounts/${profileId}/bind`, { body })
  const autoMatch = async (profileId: string) => {
    const profile = (await rows<Record<string, unknown>>(`SELECT id, "tenantId", "accountId", "bindingStatus", "sellerAccountId" FROM "AdsProfile" WHERE id = $1`, [profileId]))[0]!
    return runWithTenant(tenantId, () => autoBind(tenantDb, profile))
  }
  const audits = (action: string) =>
    rows<{ resourceId: string; result: string; reason: string | null; detail: Record<string, any>; actorId: string }>(
      `SELECT "resourceId", result, reason, detail, "actorId" FROM "AuditEvent" WHERE action = $1 AND "tenantId" = $2 AND detail ? 'change' ORDER BY "createdAt"`,
      [action, tenantId],
    )

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ads_bind' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeA2 = 'seller-a2'
    await h.client.query(`UPDATE "SellerAccount" SET "sellerId" = 'SELLER-A', "marketplaceIds" = '["ATVPDKIKX0DER"]'::jsonb WHERE id = $1`, [storeA])
    // 同一企业里再放：一个不同卖家编号的店铺，以及两个卖家编号相同的店铺（不同区域）
    const extra: [string, string, string][] = [
      [storeA2, 'SELLER-A2', 'NA'],
      ['seller-dup1', 'DUP', 'NA'],
      ['seller-dup2', 'DUP', 'EU'],
    ]
    for (const [id, sellerId, logicalRegion] of extra) await insertRow(h.client, 'SellerAccount', { id, tenantId, legalEntityId: a.legalEntityId, sellerId, logicalRegion, displayName: `店铺 ${id}` })
    // 别的企业里有一家卖家编号同样是 SELLER-A 的店铺：自动匹配与候选数都不能数到它
    await h.client.query(`UPDATE "SellerAccount" SET "sellerId" = 'SELLER-A' WHERE id = $1`, [b.sellerAccountId])

    // 本企业四个广告账户：能自动匹配的、没有卖家编号的、卖家编号有两个候选店铺的、没有同编号店铺的；别的企业一个
    const profiles: [string, string | null][] = [
      ['ap-auto', 'SELLER-A'],
      ['ap-none', null],
      ['ap-dup', 'DUP'],
      ['ap-zero', 'NOBODY'],
    ]
    for (const [id, accountId] of profiles) {
      await insertRow(h.client, 'AdsProfile', { id, tenantId, profileId: `P-${id}`, accountId, displayName: `账户 ${id}` })
      await insertRow(h.client, 'AdsCampaign', {
        id: `camp-${id}`,
        tenantId,
        adsProfileId: id,
        externalCampaignId: `C-${id}`,
        adProduct: 'SPONSORED_PRODUCTS',
        sourceUpdatedAt: '2026-10-01T00:00:00Z',
      })
      await insertRow(h.client, 'AdsMetric', { id: `met-${id}`, tenantId, adsProfileId: id, reportDate: DAY, externalCampaignId: `C-${id}`, cost: 2, purchases: 1 })
    }
    await insertRow(h.client, 'AdsProfile', { id: 'ap-b', tenantId: otherTenantId, profileId: 'P-ap-b', accountId: 'SELLER-A', displayName: '别的企业账户' })

    base = new PrismaClient({ datasourceUrl: h.db.urlFor('ads_bind', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    autoBind = (await import(/* @vite-ignore */ String('../../../worker/src/connectors/ads-binding'))).autoBindAdsProfile as AutoBind

    const read = ['connection.read', 'ads.read']
    admin = await h.createMember(tenantId, 'admin', [...read, 'ads.account.bind'])
    reader = await h.createMember(tenantId, 'reader', read)
    scopedA = await h.createMember(tenantId, 'scopeda', read, { scopes: [{ sellerAccountId: storeA }] })
    scopedA2 = await h.createMember(tenantId, 'scopeda2', read, { scopes: [{ sellerAccountId: storeA2 }] })
    scopedAWithBind = await h.createMember(tenantId, 'scopedab', [...read, 'ads.account.bind'], { scopes: [{ sellerAccountId: storeA }] })
    otherAdmin = await h.createMember(otherTenantId, 'otheradmin', [...read, 'ads.account.bind'])
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  it('自动匹配：卖家编号在本企业里只有一个店铺才绑定；零个、多个、没有卖家编号都保持未绑定；不会数到别的企业的店铺', async () => {
    expect(await autoMatch('ap-auto')).toBe('AUTO_MATCHED')
    expect(await profileRow('ap-auto')).toMatchObject({ sellerAccountId: storeA, bindingStatus: 'AUTO_MATCHED' })
    for (const id of ['ap-none', 'ap-dup', 'ap-zero']) {
      expect(await autoMatch(id), id).toBe('UNBOUND')
      expect(await profileRow(id), id).toMatchObject({ sellerAccountId: null, bindingStatus: 'UNBOUND' })
    }
    expect(await profileRow('ap-b')).toMatchObject({ sellerAccountId: null })
  })

  it('绑定清单：全部范围看到四个账户，未绑定的排前面，给出候选店铺数与原因；店铺下拉只有本企业的店铺', async () => {
    const data = await list(admin)
    expect(data.items.map(item => item.id)).toEqual(expect.arrayContaining(['ap-auto', 'ap-none', 'ap-dup', 'ap-zero']))
    expect(data.items).toHaveLength(4)
    expect(data.items[3]!.id).toBe('ap-auto') // 已自动匹配的排在最后
    const byId = Object.fromEntries(data.items.map(item => [item.id, item]))
    expect(byId['ap-none']).toMatchObject({ unboundReason: 'NO_SELLER_ID', candidateCount: 0 })
    expect(byId['ap-zero']).toMatchObject({ unboundReason: 'NO_MATCHING_STORE', candidateCount: 0 })
    expect(byId['ap-dup']).toMatchObject({ unboundReason: 'MULTIPLE_STORES', candidateCount: 2 })
    expect(byId['ap-auto']).toMatchObject({ unboundReason: null, candidateCount: 1, store: { id: storeA } }) // 别的企业那家同编号的店铺不算
    expect(data.summary).toEqual({ total: 4, autoMatched: 1, manual: 0, unbound: 3 })
    expect(data.canBind).toBe(true)
    expect((data.stores as { id: string }[]).map(store => store.id).sort()).toEqual([storeA, storeA2, 'seller-dup1', 'seller-dup2'].sort())
    const reading = await list(reader)
    expect(reading.canBind).toBe(false)
    expect(reading.stores).toEqual([])
    expect(await ids(otherAdmin)).toEqual(['ap-b'])
  })

  it('范围过滤（绑定之前）：按店铺授权的成员只看到绑定在自己店铺上的广告账户的活动与日指标；未绑定的只有全部范围的人看得到', async () => {
    expect(await campaigns(admin)).toEqual(['C-ap-auto', 'C-ap-dup', 'C-ap-none', 'C-ap-zero'])
    expect(await campaigns(scopedA)).toEqual(['C-ap-auto'])
    expect(await metrics(scopedA)).toEqual(['C-ap-auto'])
    expect(await ids(scopedA)).toEqual(['ap-auto'])
    expect(await campaigns(scopedA2)).toEqual([])
    expect(await ids(scopedA2)).toEqual([])
  })

  it('人工绑定：未绑定的账户绑到另一家店铺，记录操作人并写审计；该店铺的成员马上看得到它的活动与日指标，别人看不到', async () => {
    const res = await bind(admin, 'ap-none', { sellerAccountId: storeA2 })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ change: 'BIND', changed: true, bindingStatus: 'MANUAL', sellerAccountId: storeA2 })
    expect(await profileRow('ap-none')).toEqual({ sellerAccountId: storeA2, bindingStatus: 'MANUAL', boundBy: admin.userId })
    const [audit, ...rest] = await audits('ADS_ACCOUNT_BOUND')
    expect(rest).toEqual([])
    expect(audit).toMatchObject({ resourceId: 'ap-none', result: 'SUCCEEDED', actorId: admin.userId })
    expect(audit!.detail.change).toBe('BIND')
    expect(audit!.detail.changes).toBeTruthy()

    expect(await campaigns(scopedA2)).toEqual(['C-ap-none'])
    expect(await metrics(scopedA2)).toEqual(['C-ap-none'])
    expect(await campaigns(scopedA)).toEqual(['C-ap-auto'])
    const row = (await list(admin)).items.find(item => item.id === 'ap-none')
    expect(row).toMatchObject({ bindingStatus: 'MANUAL', unboundReason: null, store: { id: storeA2 } })
  })

  it('人工绑定永不被自动匹配覆盖；自动匹配的结果可以固定（PIN）', async () => {
    expect(await autoMatch('ap-none')).toBe('MANUAL_KEPT')
    expect(await profileRow('ap-none')).toMatchObject({ sellerAccountId: storeA2, bindingStatus: 'MANUAL' })
    const same = await bind(admin, 'ap-none', { sellerAccountId: storeA2 })
    expect(same.status).toBe(201)
    expect(same.json.data).toMatchObject({ change: 'NONE', changed: false })
    // 没有变化不写带前后值的业务审计（写接口拦截器仍会补一条通用审计，所以这里只数带 change 的）
    expect((await audits('ADS_ACCOUNT_BOUND')).length).toBe(1)

    const pin = await bind(admin, 'ap-auto', { sellerAccountId: storeA })
    expect(pin.json.data).toMatchObject({ change: 'PIN', changed: true, bindingStatus: 'MANUAL' })
    expect(await profileRow('ap-auto')).toMatchObject({ sellerAccountId: storeA, bindingStatus: 'MANUAL', boundBy: admin.userId })
    expect(await autoMatch('ap-auto')).toBe('MANUAL_KEPT')
  })

  it('改绑要写原因（422，库里不变）；写了之后范围跟着变，审计里有原因与前后值', async () => {
    const missing = await bind(admin, 'ap-none', { sellerAccountId: storeA })
    expect(missing.status).toBe(422)
    expect(await profileRow('ap-none')).toMatchObject({ sellerAccountId: storeA2 })

    const done = await bind(admin, 'ap-none', { sellerAccountId: storeA, reason: '这个广告账户实际属于主店' })
    expect(done.status, JSON.stringify(done.json)).toBe(201)
    expect(done.json.data.change).toBe('REBIND')
    expect(await profileRow('ap-none')).toMatchObject({ sellerAccountId: storeA, bindingStatus: 'MANUAL' })
    expect(await campaigns(scopedA)).toEqual(['C-ap-auto', 'C-ap-none'])
    expect(await campaigns(scopedA2)).toEqual([])
    const audit = (await audits('ADS_ACCOUNT_BOUND')).find(item => item.reason === '这个广告账户实际属于主店')!
    expect(audit).toMatchObject({ resourceId: 'ap-none', result: 'SUCCEEDED' })
    expect(JSON.stringify(audit.detail.changes)).toContain(storeA2)
  })

  it('解除绑定：要写原因，回到未绑定，范围内的成员看不到了，全部范围的人仍然看得到；审计动作是解除', async () => {
    expect((await bind(admin, 'ap-none', { sellerAccountId: null })).status).toBe(422)
    const done = await bind(admin, 'ap-none', { sellerAccountId: null, reason: '确认不属于任何已连接的店铺' })
    expect(done.status, JSON.stringify(done.json)).toBe(201)
    expect(done.json.data).toMatchObject({ change: 'UNBIND', bindingStatus: 'UNBOUND', sellerAccountId: null })
    expect(await profileRow('ap-none')).toEqual({ sellerAccountId: null, bindingStatus: 'UNBOUND', boundBy: null })
    expect(await campaigns(scopedA)).toEqual(['C-ap-auto'])
    expect(await campaigns(admin)).toContain('C-ap-none')
    expect((await audits('ADS_ACCOUNT_UNBOUND')).map(item => item.resourceId)).toEqual(['ap-none'])
  })

  it('权限与隔离：没有绑定权限 403；按店铺授权的人即使有绑定权限也不能改（影响全部店铺）；别的企业碰不到；店铺必须是本企业的', async () => {
    const before = await profileRow('ap-zero')
    expect((await bind(reader, 'ap-zero', { sellerAccountId: storeA })).status).toBe(403)
    const scoped = await bind(scopedAWithBind, 'ap-zero', { sellerAccountId: storeA })
    expect(scoped.status).toBe(403)
    expect(scoped.json.error.code).toBe('SCOPE_TENANT_LEVEL_ONLY')
    expect((await bind(otherAdmin, 'ap-zero', { sellerAccountId: storeA })).status).toBe(404) // 别的企业的广告账户与不存在一样
    const foreignStore = await bind(admin, 'ap-zero', { sellerAccountId: 'seller-b' })
    expect(foreignStore.status).toBe(422)
    expect((await bind(admin, 'no-such-profile', { sellerAccountId: storeA })).status).toBe(404)
    expect(await profileRow('ap-zero')).toEqual(before)
    expect(await profileRow('ap-b')).toMatchObject({ sellerAccountId: null, bindingStatus: 'UNBOUND' })
  })

  it('店铺被移除后：人工绑定变成“已移除”的未绑定，原因写明；可以重新人工绑定', async () => {
    await insertRow(h.client, 'SellerAccount', {
      id: 'seller-gone',
      tenantId,
      legalEntityId: (await rows<{ id: string }>(`SELECT id FROM "LegalEntity" WHERE "tenantId" = $1`, [tenantId]))[0]!.id,
      sellerId: 'GONE',
      logicalRegion: 'NA',
    })
    expect((await bind(admin, 'ap-zero', { sellerAccountId: 'seller-gone' })).status).toBe(201)
    await h.client.query(`DELETE FROM "SellerAccount" WHERE id = 'seller-gone'`)
    expect(await profileRow('ap-zero')).toMatchObject({ sellerAccountId: null, bindingStatus: 'MANUAL' })
    const row = (await list(admin)).items.find(item => item.id === 'ap-zero')
    expect(row).toMatchObject({ unboundReason: 'RELEASED', store: null })
    const again = await bind(admin, 'ap-zero', { sellerAccountId: storeA2 })
    expect(again.json.data).toMatchObject({ change: 'BIND', bindingStatus: 'MANUAL' })
  })
})
