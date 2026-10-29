import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 刊登质量与写入（P4-10，真实数据库 + 完整应用）：七个页签的读取与计数、数据范围与企业隔离、校验预览 → 修改刊登的令牌规则
// （必须先校验通过、未过期、内容一致、同一商品不并发）、开关与连接、批量任务的校验、记录与任务同一事务、约束。

type Member = { userId: string; token: string }

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const SKU = 'SKU-1'
const PATCH = { op: 'replace', attribute: 'item_name', values: ['新标题'] }
const WRITE = ['listing.read', 'listing.write']

describe('刊登质量与写入（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let storeB: string
  let owner: Member
  let reader: Member
  let scopedB: Member
  let outsider: Member
  let seq = 0

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const count = async (table: string, where = 'TRUE', params: unknown[] = []) => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`, params))[0]!.n
  const quality = async (member: Member, query = '', expected = 200) => {
    const res = await h.call(member.token, 'GET', `/listings/quality${query ? `?${query}` : ''}`)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Record<string, any>
  }
  const post = (member: Member, path: string, body: unknown) => h.call(member.token, 'POST', path, { body })
  const setSwitch = (key: string, enabled: boolean) => h.client.query(`UPDATE "IntegrationSwitch" SET enabled = $1 WHERE "tenantId" = $2 AND "switchKey" = $3`, [enabled, tenantId, key])
  const validBody = (over: Record<string, unknown> = {}) => ({ storeId: storeA, sku: SKU, patches: [PATCH], ...over })

  const snapshot = (id: string, sku: string, values: Record<string, unknown> = {}) =>
    insertRow(h.client, 'ListingSnapshot', { id, tenantId, sellerAccountId: storeA, sellerSku: sku, asin: `B0${sku}`, productType: 'LUGGAGE', status: 'ACTIVE', statusSince: ago(10), ...values })
  const issue = (code: string, values: Record<string, unknown> = {}) =>
    insertRow(h.client, 'ListingIssue', {
      id: `iss-${(seq += 1)}`,
      tenantId,
      sellerAccountId: storeA,
      sellerSku: SKU,
      asin: 'B0SKU-1',
      issueKind: 'ISSUE',
      issueCode: code,
      severity: 'ERROR',
      message: `问题 ${code}`,
      firstSeenAt: ago(3),
      lastSeenAt: ago(1),
      ...values,
    })
  const previewRun = (id: string, values: Record<string, unknown> = {}) =>
    insertRow(h.client, 'ListingWriteRun', {
      id,
      tenantId,
      sellerAccountId: storeA,
      kind: 'VALIDATE',
      sellerSku: SKU,
      productType: 'LUGGAGE',
      status: 'SUCCEEDED',
      validation: 'VALID',
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      ...values,
    })

  /** 用接口提交一次校验预览，再模拟 worker 把它标为通过（预览是否通过由后台判断，这里只验证 API 的令牌规则）。 */
  const approvedPreview = async (body: Record<string, unknown> = validBody(), values: Record<string, unknown> = {}) => {
    const res = await post(owner, '/listings/validate', body)
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    const id = res.json.data.run.id as string
    await h.client.query(`UPDATE "ListingWriteRun" SET status = 'SUCCEEDED', validation = 'VALID', "expiresAt" = $2 WHERE id = $1`, [
      id,
      values.expiresAt ?? new Date(Date.now() + 20 * 60_000).toISOString(),
    ])
    return id
  }

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'listing_quality' })
    const a = await h.createTenant('lq-a')
    const b = await h.createTenant('lq-b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-lq-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-LQ-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    for (const [id, store] of [
      ['conn-lq-a', storeA],
      ['conn-lq-b', storeB],
    ] as const)
      await insertRow(h.client, 'PlatformConnection', { id, tenantId, provider: 'AMAZON_SP_API', sellerAccountId: store, state: 'AUTHORIZED', encryptedRefreshToken: 'cipher' })
    for (const key of ['sw.listing.update', 'sw.feeds.batch']) await insertRow(h.client, 'IntegrationSwitch', { id: `sw-${key}`, tenantId, switchKey: key, enabled: true })
    owner = await h.createMember(tenantId, 'owner', WRITE)
    reader = await h.createMember(tenantId, 'reader', ['listing.read'])
    scopedB = await h.createMember(tenantId, 'scopedb', WRITE, { scopes: [{ sellerAccountId: storeB }] })
    outsider = await h.createMember(otherTenantId, 'outsider', WRITE)
  })
  afterAll(async () => {
    await h?.close()
  })

  describe('读取', () => {
    it('没有任何数据：未接入时是 NOT_CONNECTED，计数全是 0 而来源如实写尚未接入', async () => {
      const data = await quality(owner)
      expect(data).toMatchObject({
        tab: 'issues',
        state: 'NOT_CONNECTED',
        issueRows: [],
        counts: { issues: 0, suppressed: 0, restrictions: 0, missing: 0, productType: 0, otherEdits: 0, inactive: 0 },
      })
      const push = (data.sources as Array<{ key: string; state: string }>).find(source => source.key === 'notifications')
      expect(push?.state).toBe('NOT_CONNECTED')
    })

    it('写入通道状态：有权限、有连接、开关开着都通过；只读成员卡在权限；开关关闭卡在开关（只影响对应的那一类）', async () => {
      expect((await quality(owner)).write).toMatchObject({ validate: { allowed: true }, update: { allowed: true, step: null }, batch: { allowed: true } })
      expect((await quality(reader)).write).toMatchObject({ validate: { allowed: false, step: 'PERMISSION' }, update: { allowed: false, step: 'PERMISSION' } })
      await setSwitch('sw.feeds.batch', false)
      const write = (await quality(owner)).write
      expect(write).toMatchObject({ validate: { allowed: true }, update: { allowed: true }, batch: { allowed: false, step: 'SWITCH' } })
      await setSwitch('sw.feeds.batch', true)
    })

    it('问题页签、被搜索抑制、缺少必填属性：按类型与是否解决分开计数，已解决的不在列表里', async () => {
      await snapshot('snap-1', SKU)
      await issue('90220', { category: 'MISSING_ATTRIBUTE', attributeName: 'color' })
      await issue('8541', { issueKind: 'SEARCH_SUPPRESSED', severity: 'WARNING', impact: 'SEARCH_SUPPRESSED' })
      await issue('99999', { resolvedAt: ago(1), firstSeenAt: ago(6) })
      const data = await quality(owner)
      expect(data.counts).toMatchObject({ issues: 1, suppressed: 1, missing: 1 })
      expect(data.issueRows).toHaveLength(1)
      expect(data.issueRows[0]).toMatchObject({ sku: SKU, code: '90220' })
      const suppressed = await quality(owner, 'tab=suppressed')
      expect(suppressed.issueRows.map((row: { code: string }) => row.code)).toEqual(['8541'])
      expect((await quality(owner, 'tab=missing')).issueRows).toHaveLength(1)
      expect(data.stats).toMatchObject({ openCount: 2, resolvedCount: 1 })
    })

    it('筛选与排序：严重程度、影响与不认识的取值', async () => {
      expect((await quality(owner, 'severity=WARNING&tab=suppressed')).issueRows).toHaveLength(1)
      expect((await quality(owner, 'severity=WARNING')).issueRows).toHaveLength(0)
      await quality(owner, 'severity=BAD', 422)
      await quality(owner, 'tab=nope', 422)
      await quality(owner, 'sort=password:asc', 422)
    })

    it('非活跃、商品类型变更、非本系统修改三个页签；本系统自己的修改不算“别人改的”', async () => {
      await snapshot('snap-2', 'SKU-2', { status: 'INACTIVE', statusSince: ago(40) })
      await insertRow(h.client, 'ListingChangeEvent', {
        id: 'ce-1',
        tenantId,
        sellerAccountId: storeA,
        sellerSku: SKU,
        changeKind: 'PRODUCT_TYPE_CHANGE',
        actorKind: 'UNKNOWN',
        beforeText: 'LUGGAGE',
        afterText: 'SHIRT',
        occurredAt: ago(2),
        sourceRef: 'd1',
      })
      await insertRow(h.client, 'ListingChangeEvent', {
        id: 'ce-2',
        tenantId,
        sellerAccountId: storeA,
        sellerSku: SKU,
        changeKind: 'CONTENT_CHANGE',
        fieldPath: 'item_name',
        actorKind: 'UNKNOWN',
        occurredAt: ago(2),
        sourceRef: 'd1',
      })
      await insertRow(h.client, 'ListingChangeEvent', {
        id: 'ce-3',
        tenantId,
        sellerAccountId: storeA,
        sellerSku: SKU,
        changeKind: 'CONTENT_CHANGE',
        fieldPath: 'main_image',
        actorKind: 'SELF',
        occurredAt: ago(1),
        sourceRef: 'd2',
      })
      expect((await quality(owner, 'tab=inactive')).inactiveRows).toHaveLength(1)
      expect((await quality(owner, 'tab=productType')).changeRows).toHaveLength(1)
      const other = await quality(owner, 'tab=otherEdits')
      expect(other.changeRows.map((row: { fieldPath: string }) => row.fieldPath)).toEqual(['item_name'])
      expect(other.counts).toMatchObject({ productType: 1, otherEdits: 1, inactive: 1 })
    })

    it('刊登限制页签只显示未过期的成功结果', async () => {
      const result = { rows: [{ asin: 'B0AAAAAAAA', restricted: true, reasons: [{ code: 'APPROVAL_REQUIRED', message: '需要审核' }] }] }
      await insertRow(h.client, 'ListingWriteRun', {
        id: 'rs-old',
        tenantId,
        sellerAccountId: storeA,
        kind: 'RESTRICTIONS',
        status: 'SUCCEEDED',
        resultJson: JSON.stringify(result),
        expiresAt: ago(0.5),
      })
      await insertRow(h.client, 'ListingWriteRun', {
        id: 'rs-new',
        tenantId,
        sellerAccountId: storeA,
        kind: 'RESTRICTIONS',
        status: 'SUCCEEDED',
        resultJson: JSON.stringify(result),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      })
      const data = await quality(owner, 'tab=restrictions')
      expect(data.restrictionRows.length).toBeGreaterThan(0)
      expect(data.counts.restrictions).toBe(1)
    })

    it('数据范围与企业隔离：只授权店铺 B 的成员看不到店铺 A 的数据；别的企业什么都看不到；只读成员可以读', async () => {
      expect((await quality(scopedB)).issueRows).toEqual([])
      expect((await quality(scopedB)).counts).toMatchObject({ issues: 0, inactive: 0 })
      expect((await quality(outsider)).counts).toMatchObject({ issues: 0, suppressed: 0, inactive: 0, productType: 0 })
      expect((await quality(reader)).issueRows).toHaveLength(1)
    })
  })

  describe('校验预览', () => {
    it('提交：记录与同步任务同一事务，响应是排队状态；不需要写入开关；入队载荷带记录编号；写审计', async () => {
      await setSwitch('sw.listing.update', false)
      const before = await count('AuditEvent', `action = 'LISTING_VALIDATE_REQUESTED'`)
      const res = await post(owner, '/listings/validate', validBody())
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect(res.json.data).toMatchObject({ state: 'QUEUED', run: { kind: 'VALIDATE', status: 'PENDING', sku: SKU, productType: 'LUGGAGE', storeName: expect.any(String) } })
      const runId = res.json.data.run.id as string
      const [run] = await rows<Record<string, any>>(`SELECT * FROM "ListingWriteRun" WHERE id = $1`, [runId])
      expect(run).toMatchObject({ tenantId, sellerAccountId: storeA, requestedBy: owner.userId, finishedAt: null, itemCount: 1 })
      expect(run.requestHash).not.toBe('')
      const [job] = await rows<Record<string, any>>(`SELECT * FROM "SyncJob" WHERE id = $1`, [run.syncJobId])
      expect(job).toMatchObject({ type: 'LISTING_WRITE', connectionId: 'conn-lq-a', status: 'PENDING' })
      expect(job.context).toMatchObject({ listingRunId: runId })
      expect(h.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ listingRunId: runId, syncJobId: job.id }), job.id, expect.objectContaining({ type: 'LISTING_WRITE' }))
      expect(await count('AuditEvent', `action = 'LISTING_VALIDATE_REQUESTED'`)).toBe(before + 1)
      await setSwitch('sw.listing.update', true)
    })

    it('商品类型：请求里没有、同步数据里也没有时是 422 并且没有任何记录', async () => {
      const before = await count('ListingWriteRun')
      const res = await post(owner, '/listings/validate', validBody({ sku: 'NO-SUCH-SKU' }))
      expect(res.status).toBe(422)
      expect(await count('ListingWriteRun')).toBe(before)
      expect((await post(owner, '/listings/validate', validBody({ sku: 'NO-SUCH-SKU', productType: 'SHIRT' }))).status).toBe(201)
    })

    it('权限与范围：只读 403；范围外的店铺 403；别的企业的店铺 404；没有授权连接 409', async () => {
      const before = await count('ListingWriteRun')
      expect((await post(reader, '/listings/validate', validBody())).status).toBe(403)
      expect((await post(scopedB, '/listings/validate', validBody())).status).toBe(403)
      expect((await post(outsider, '/listings/validate', validBody())).status).toBe(404)
      await h.client.query(`UPDATE "PlatformConnection" SET state = 'REVOKED' WHERE id = 'conn-lq-b'`)
      const noConn = await post(owner, '/listings/validate', validBody({ storeId: storeB, productType: 'SHIRT' }))
      expect(noConn.status).toBe(409)
      await h.client.query(`UPDATE "PlatformConnection" SET state = 'AUTHORIZED' WHERE id = 'conn-lq-b'`)
      expect(await count('ListingWriteRun')).toBe(before)
    })
  })

  describe('修改刊登', () => {
    it('没有预览编号 422；预览不存在、没通过、已过期或内容不一致都是 409，并且没有新记录', async () => {
      const before = await count('ListingWriteRun', `kind = 'PATCH'`)
      expect((await post(owner, '/listings/patch', { storeId: storeA, sku: SKU, patches: [PATCH] })).status).toBe(422)
      const missing = await post(owner, '/listings/patch', validBody({ previewRunId: 'nope' }))
      expect(missing).toMatchObject({ status: 409 })
      await previewRun('pv-invalid', { validation: 'INVALID' })
      expect((await post(owner, '/listings/patch', validBody({ previewRunId: 'pv-invalid' }))).status).toBe(409)
      const expired = await approvedPreview(validBody(), { expiresAt: ago(0.01) })
      expect((await post(owner, '/listings/patch', validBody({ previewRunId: expired }))).json.error.details).toMatchObject({ code: 'PREVIEW_EXPIRED' })
      const ok = await approvedPreview()
      const changed = await post(owner, '/listings/patch', validBody({ previewRunId: ok, patches: [{ ...PATCH, values: ['另一个标题'] }] }))
      expect(changed.status).toBe(409)
      expect(changed.json.error.details).toMatchObject({ code: 'PREVIEW_MISMATCH' })
      expect(await count('ListingWriteRun', `kind = 'PATCH'`)).toBe(before)
    })

    it('开关关闭 409 且没有记录；开启后用通过的预览提交成功，排队并登记流程；同一商品没完成前不能再提交', async () => {
      const preview = await approvedPreview()
      await setSwitch('sw.listing.update', false)
      const off = await post(owner, '/listings/patch', validBody({ previewRunId: preview }))
      expect(off.status).toBe(409)
      expect(await count('ListingWriteRun', `kind = 'PATCH'`)).toBe(0)
      await setSwitch('sw.listing.update', true)
      const res = await post(owner, '/listings/patch', validBody({ previewRunId: preview }))
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect(res.json.data).toMatchObject({ state: 'QUEUED', run: { kind: 'PATCH', status: 'PENDING', previewRunId: preview } })
      const runId = res.json.data.run.id as string
      expect(await count('WorkflowRun', `kind = 'listing.write'`)).toBeGreaterThanOrEqual(1)
      expect(h.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ listingRunId: runId }), expect.any(String), expect.objectContaining({ type: 'LISTING_WRITE' }))
      expect(await count('AuditEvent', `action = 'LISTING_PATCH_SUBMITTED'`)).toBe(1)
      const again = await post(owner, '/listings/patch', validBody({ previewRunId: preview }))
      expect(again.status).toBe(409)
      expect(again.json.error.details).toMatchObject({ code: 'LISTING_RUN_STALE' })
      await h.client.query(`UPDATE "ListingWriteRun" SET status = 'SUCCEEDED' WHERE id = $1`, [runId])
    })

    it('入队失败：记录与任务标为失败（QUEUE_UNAVAILABLE），响应是 FAILED 而不是假装排队', async () => {
      const preview = await approvedPreview()
      h.queue.add.mockRejectedValueOnce(new Error('redis down'))
      const res = await post(owner, '/listings/patch', validBody({ previewRunId: preview }))
      expect(res.status).toBe(201)
      expect(res.json.data).toMatchObject({ state: 'FAILED', run: { status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE' } })
      const [job] = await rows<Record<string, any>>(`SELECT j.status FROM "ListingWriteRun" r JOIN "SyncJob" j ON j.id = r."syncJobId" WHERE r.id = $1`, [res.json.data.run.id])
      expect(job?.status).toBe('FAILED_PERMANENT')
    })
  })

  describe('批量任务与刊登限制', () => {
    it('批量：缺少已同步商品类型的 SKU 是 422 且没有记录；全部有则整体入队，开关是批量开关', async () => {
      const before = await count('ListingWriteRun', `kind = 'BATCH'`)
      const bad = await post(owner, '/listings/batch', {
        storeId: storeA,
        items: [
          { sku: SKU, patches: [PATCH] },
          { sku: 'GHOST', patches: [PATCH] },
        ],
      })
      expect(bad.status).toBe(422)
      expect(await count('ListingWriteRun', `kind = 'BATCH'`)).toBe(before)
      await setSwitch('sw.feeds.batch', false)
      expect((await post(owner, '/listings/batch', { storeId: storeA, items: [{ sku: SKU, patches: [PATCH] }] })).status).toBe(409)
      await setSwitch('sw.feeds.batch', true)
      const res = await post(owner, '/listings/batch', {
        storeId: storeA,
        items: [
          { sku: SKU, patches: [PATCH] },
          { sku: 'SKU-2', patches: [PATCH] },
        ],
      })
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect(res.json.data).toMatchObject({ state: 'QUEUED', run: { kind: 'BATCH', itemCount: 2 } })
      const [run] = await rows<Record<string, any>>(`SELECT "requestJson" FROM "ListingWriteRun" WHERE id = $1`, [res.json.data.run.id])
      expect(run!.requestJson.items.map((item: { productType: string }) => item.productType)).toEqual(['LUGGAGE', 'LUGGAGE'])
    })

    it('刊登限制查询：只读权限即可，不需要写入开关，ASIN 去重', async () => {
      await setSwitch('sw.listing.update', false)
      await setSwitch('sw.feeds.batch', false)
      const res = await post(reader, '/listings/restrictions', { storeId: storeA, asins: ['B0AAAAAAAA', 'B0AAAAAAAA', 'B0BBBBBBBB'], conditionType: 'new_new' })
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect(res.json.data.run).toMatchObject({ kind: 'RESTRICTIONS', itemCount: 2 })
      await setSwitch('sw.listing.update', true)
      await setSwitch('sw.feeds.batch', true)
    })
  })

  describe('操作记录', () => {
    it('列表按时间倒序，可按类型筛选；只返回范围内的记录；别的企业与范围外的详情是 404', async () => {
      const all = await h.call(owner.token, 'GET', '/listings/runs')
      expect(all.status).toBe(200)
      const items = all.json.data.items as Array<{ id: string; kind: string; createdAt: string; storeId: string }>
      expect(items.length).toBeGreaterThan(3)
      expect([...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => item.id)).toEqual(items.map(item => item.id))
      const batches = (await h.call(owner.token, 'GET', '/listings/runs?kind=BATCH')).json.data.items as Array<{ kind: string }>
      expect(batches.length).toBeGreaterThan(0)
      expect(batches.every(item => item.kind === 'BATCH')).toBe(true)
      expect((await h.call(scopedB.token, 'GET', '/listings/runs')).json.data.items).toEqual([])
      const id = items[0]!.id
      expect((await h.call(owner.token, 'GET', `/listings/runs/${id}`)).json.data.id).toBe(id)
      expect((await h.call(scopedB.token, 'GET', `/listings/runs/${id}`)).status).toBe(404)
      expect((await h.call(outsider.token, 'GET', `/listings/runs/${id}`)).status).toBe(404)
      expect((await h.call(owner.token, 'GET', '/listings/runs?kind=BAD')).status).toBe(422)
    })
  })

  describe('约束', () => {
    it('同店铺同 SKU 只有一行当前状态；同一问题只有一行；变更事件按来源去重', async () => {
      await expect(snapshot('snap-dup', SKU)).rejects.toMatchObject({ code: '23505' })
      await expect(issue('90220', { attributeName: 'color' })).rejects.toMatchObject({ code: '23505' })
      await expect(
        insertRow(h.client, 'ListingChangeEvent', {
          id: 'ce-dup',
          tenantId,
          sellerAccountId: storeA,
          sellerSku: SKU,
          changeKind: 'PRODUCT_TYPE_CHANGE',
          actorKind: 'UNKNOWN',
          occurredAt: ago(2),
          sourceRef: 'd1',
        }),
      ).rejects.toMatchObject({ code: '23505' })
    })

    it('状态、严重程度、影响、类型只接受约定取值', async () => {
      await expect(snapshot('snap-bad', 'SKU-X', { status: 'WHATEVER' })).rejects.toMatchObject({ code: '23514' })
      await expect(issue('1', { severity: 'FATAL' })).rejects.toMatchObject({ code: '23514' })
      await expect(issue('2', { impact: 'EXPLODED' })).rejects.toMatchObject({ code: '23514' })
      await expect(issue('3', { issueKind: 'OTHER' })).rejects.toMatchObject({ code: '23514' })
      await expect(previewRun('run-bad-kind', { kind: 'DELETE_ALL' })).rejects.toMatchObject({ code: '23514' })
      await expect(previewRun('run-bad-status', { status: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    })
  })
})
