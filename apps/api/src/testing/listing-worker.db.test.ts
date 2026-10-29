import { gzipSync } from 'node:zlib'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 刊登后台任务（P4-10，真实数据库 + worker 的同步、分发、写入流程代码）：每日同步的状态与问题生命周期（新增、解决、重开）、
// 变更事件的行为人判断、翻不完不做整体对账、角色缺失；校验预览与刊登限制查询的结果写回；批量任务的轮询与结果；写入流程的回写与幂等；失败处置。

type Member = { userId: string; token: string }
type Json = ReturnType<typeof JSON.parse>

const US = 'ATVPDKIKX0DER'
const DAY = 86_400_000
const T0 = new Date('2026-10-20T03:00:00Z')
const at = (days: number) => new Date(T0.getTime() + days * DAY)

const listing = (sku: string, over: Json = {}, issues: Json[] = []) => ({
  sku,
  summaries: [
    {
      marketplaceId: US,
      asin: `B0${sku.replace(/\W/g, '').toUpperCase().padEnd(8, '0').slice(0, 8)}`,
      productType: 'LUGGAGE',
      conditionType: 'new_new',
      status: ['BUYABLE'],
      itemName: `标题 ${sku}`,
      mainImage: { link: `https://img/${sku}.jpg` },
      ...over,
    },
  ],
  issues,
})
const colorIssue = { code: '90220', message: '缺少颜色', severity: 'ERROR', attributeNames: ['color'], categories: ['MISSING_ATTRIBUTE'], enforcements: { actions: [{ action: 'SEARCH_SUPPRESSED' }] } }

describe('刊登后台任务（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let tenantId: string
  let storeId: string
  let owner: Member
  let sync: (ctx: unknown, api: unknown, scope: unknown, options?: unknown) => Promise<Json>
  let dispatch: { processListingWrite: (...args: unknown[]) => Promise<Json>; markListingRunFailed: (db: unknown, tenantId: string, payload: unknown, code: string) => Promise<void> }
  let workflow: { createListingWriteWorkflow: (deps: unknown) => { steps: Array<{ run: (ctx: unknown) => Promise<Json>; reconcile?: (ctx: unknown) => Promise<Json> }> } }
  let seq = 0
  // 库里的时间列不带时区，pg 驱动按本机时区解释；还原成存入的 UTC 时间再比较
  const utc = (value: Date | null | undefined) => (value ? new Date(value.getTime() - value.getTimezoneOffset() * 60_000) : value)

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  const scope = () => ({ tenantId, sellerAccountId: storeId })
  const run = <T>(fn: () => Promise<T>) => runWithTenant(tenantId, fn)
  const pages = (list: Json[][]) => ({
    search: vi.fn(async (token?: string) => {
      const index = token ? Number(token) : 0
      return { items: list[index], ...(index + 1 < list.length ? { pagination: { nextToken: String(index + 1) } } : {}) }
    }),
  })
  const doSync = (api: unknown, now: Date, options: Json = {}) => run(() => sync({ prisma: tenantDb, logger }, api, scope(), { now, ...options }))
  const issueOf = async (sku: string, code = '90220') => (await rows<Json>(`SELECT * FROM "ListingIssue" WHERE "sellerSku" = $1 AND "issueCode" = $2`, [sku, code]))[0]
  const quality = async (query = '') => (await h.call(owner.token, 'GET', `/listings/quality${query ? `?${query}` : ''}`)).json.data as Json
  const newRun = (values: Json) => insertRow(h.client, 'ListingWriteRun', { id: `wr-${(seq += 1)}`, tenantId, sellerAccountId: storeId, ...values })
  const runRow = async (id: string) => (await rows<Json>(`SELECT * FROM "ListingWriteRun" WHERE id = $1`, [id]))[0]

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'listing_worker' })
    const a = await h.createTenant('lw-a')
    tenantId = a.tenantId
    storeId = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    await h.client.query(`UPDATE "SellerAccount" SET "sellerId" = 'SELLER-LW' WHERE id = $1`, [storeId])
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-lw', tenantId, provider: 'AMAZON_SP_API', sellerAccountId: storeId, state: 'AUTHORIZED', encryptedRefreshToken: 'cipher' })
    base = new PrismaClient({ datasourceUrl: h.db.urlFor('listing_worker', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    sync = (await import(/* @vite-ignore */ String('../../../worker/src/importers/listings/items-sync'))).syncListings
    dispatch = await import(/* @vite-ignore */ String('../../../worker/src/connectors/listing-dispatch'))
    workflow = await import(/* @vite-ignore */ String('../../../worker/src/runtime/listing-write-workflow'))
    owner = await h.createMember(tenantId, 'owner', ['listing.read', 'listing.write'])
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  describe('每日同步', () => {
    it('首次同步：写当前状态与问题，不产生变更事件（首次填入不算变更）；接口读到的问题出现在页面', async () => {
      const api = pages([[listing('SKU-1', {}, [colorIssue]), listing('SKU-2', { status: ['DISCOVERABLE'] }), { summaries: [] }]])
      const result = await doSync(api, at(0))
      expect(result).toMatchObject({ notApplicable: false, listings: 2, issuesOpened: 1, issuesResolved: 0, changes: 0, skipped: 1, incomplete: false })
      expect(await rows(`SELECT 1 FROM "ListingSnapshot"`)).toHaveLength(2)
      expect((await rows<Json>(`SELECT status, "productType" FROM "ListingSnapshot" WHERE "sellerSku" = 'SKU-2'`))[0]).toEqual({ status: 'INACTIVE', productType: 'LUGGAGE' })
      expect(await rows(`SELECT 1 FROM "ListingChangeEvent"`)).toHaveLength(0)
      const data = await quality()
      expect(data.counts).toMatchObject({ issues: 1, missing: 1, suppressed: 1, inactive: 1 })
      expect(data.issueRows[0]).toMatchObject({ sku: 'SKU-1', code: '90220', impact: 'SEARCH_SUPPRESSED', category: 'MISSING_ATTRIBUTE', status: 'NEW' })
    })

    it('第二天：标题与商品类型变了记变更事件（行为人未知）；问题消失写解决时间；新问题新增；状态不变时不重置状态起点', async () => {
      const api = pages([
        [listing('SKU-1', { itemName: '新标题', productType: 'SHIRT' }), listing('SKU-2', { status: ['DISCOVERABLE'] }, [{ code: '8541', message: '建议补充', severity: 'WARNING' }])],
      ])
      const result = await doSync(api, at(1))
      expect(result).toMatchObject({ listings: 2, issuesOpened: 1, issuesResolved: 1, changes: 2, incomplete: false })
      const events = await rows<Json>(`SELECT "changeKind", "fieldPath", "beforeText", "afterText", "actorKind", "sourceRef" FROM "ListingChangeEvent" ORDER BY "changeKind"`)
      expect(events).toEqual([
        { changeKind: 'CONTENT_CHANGE', fieldPath: 'item_name', beforeText: '标题 SKU-1', afterText: '新标题', actorKind: 'UNKNOWN', sourceRef: `sync:${at(1).toISOString().slice(0, 10)}` },
        { changeKind: 'PRODUCT_TYPE_CHANGE', fieldPath: '', beforeText: 'LUGGAGE', afterText: 'SHIRT', actorKind: 'UNKNOWN', sourceRef: `sync:${at(1).toISOString().slice(0, 10)}` },
      ])
      expect(utc((await issueOf('SKU-1'))?.resolvedAt)).toEqual(at(1))
      expect(utc((await rows<Json>(`SELECT "statusSince" FROM "ListingSnapshot" WHERE "sellerSku" = 'SKU-2'`))[0].statusSince)).toEqual(at(0))
      const other = await quality('tab=otherEdits')
      expect(other.changeRows.map((row: Json) => row.fieldPath)).toEqual(['item_name'])
      expect((await quality('tab=productType')).changeRows[0]).toMatchObject({ before: 'LUGGAGE', after: 'SHIRT' })
      expect((await quality()).stats).toMatchObject({ resolvedCount: 1 })
    })

    it('同一天重复同步：不重复写变更事件与问题', async () => {
      const api = pages([
        [listing('SKU-1', { itemName: '新标题', productType: 'SHIRT' }), listing('SKU-2', { status: ['DISCOVERABLE'] }, [{ code: '8541', message: '建议补充', severity: 'WARNING' }])],
      ])
      const again = await doSync(api, at(1))
      expect(again).toMatchObject({ issuesOpened: 0, issuesResolved: 0, changes: 0 })
      expect(await rows(`SELECT 1 FROM "ListingChangeEvent"`)).toHaveLength(2)
      expect(await rows(`SELECT 1 FROM "ListingIssue"`)).toHaveLength(2)
    })

    it('问题再次出现：重开，首次出现时间重置，版本号加一；状态变化重置状态起点', async () => {
      const api = pages([[listing('SKU-1', { itemName: '新标题', productType: 'SHIRT' }, [colorIssue]), listing('SKU-2', { status: ['BUYABLE'] })]])
      const result = await doSync(api, at(2))
      expect(result).toMatchObject({ issuesOpened: 1, issuesResolved: 1 })
      const reopened = await issueOf('SKU-1')
      expect(reopened).toMatchObject({ resolvedAt: null, version: 2, handlingStatus: 'OPEN' })
      expect(utc(reopened.firstSeenAt)).toEqual(at(2))
      const sku2 = (await rows<Json>(`SELECT status, "statusSince" FROM "ListingSnapshot" WHERE "sellerSku" = 'SKU-2'`))[0]
      expect({ status: sku2.status, statusSince: utc(sku2.statusSince) }).toEqual({ status: 'ACTIVE', statusSince: at(2) })
      expect(utc((await issueOf('SKU-2', '8541'))?.resolvedAt)).toEqual(at(2))
    })

    it('本系统最近成功修改过的商品：内容变化记为本系统，并关联任务；不进“他人内容修改”', async () => {
      const patchRun = await newRun({ kind: 'PATCH', sellerSku: 'SKU-1', productType: 'SHIRT', status: 'SUCCEEDED', finishedAt: at(3.5).toISOString() })
      await doSync(pages([[listing('SKU-1', { itemName: '我们改的标题', productType: 'SHIRT' }, [colorIssue]), listing('SKU-2')]]), at(4))
      const [event] = await rows<Json>(`SELECT "actorKind", "writeRunId", "afterText" FROM "ListingChangeEvent" WHERE "afterText" = '我们改的标题'`)
      expect(event).toEqual({ actorKind: 'SELF', writeRunId: patchRun.id, afterText: '我们改的标题' })
      expect((await quality('tab=otherEdits')).changeRows.map((row: Json) => row.after)).not.toContain('我们改的标题')
    })

    it('超过三天以前的修改不算“刚改的”：之后的变化记为未知来源', async () => {
      await doSync(pages([[listing('SKU-1', { itemName: '别人改的标题', productType: 'SHIRT' }, [colorIssue]), listing('SKU-2')]]), at(9))
      const [event] = await rows<Json>(`SELECT "actorKind", "writeRunId" FROM "ListingChangeEvent" WHERE "afterText" = '别人改的标题'`)
      expect(event).toEqual({ actorKind: 'UNKNOWN', writeRunId: null })
    })

    it('翻不完：标记未完成，只处理读到的商品，没读到的问题不被当作已解决；读完整的一轮才做整体对账', async () => {
      await insertRow(h.client, 'ListingIssue', {
        id: 'stale-1',
        tenantId,
        sellerAccountId: storeId,
        sellerSku: 'SKU-GONE',
        issueKind: 'ISSUE',
        issueCode: 'X1',
        severity: 'ERROR',
        message: '陈旧',
        firstSeenAt: at(0).toISOString(),
        lastSeenAt: at(1).toISOString(),
      })
      const partial = pages([[listing('SKU-1', { itemName: '别人改的标题', productType: 'SHIRT' }, [colorIssue])], [listing('SKU-2')]])
      const first = await doSync(partial, at(10), { maxPages: 1 })
      expect(first).toMatchObject({ incomplete: true, issuesResolved: 0 })
      expect(logger.warn).toHaveBeenCalled()
      expect((await rows<Json>(`SELECT "resolvedAt" FROM "ListingIssue" WHERE id = 'stale-1'`))[0].resolvedAt).toBeNull()
      const full = await doSync(pages([[listing('SKU-1', { itemName: '别人改的标题', productType: 'SHIRT' }, [colorIssue]), listing('SKU-2')]]), at(11))
      expect(full).toMatchObject({ incomplete: false, issuesResolved: 1 })
      expect(utc((await rows<Json>(`SELECT "resolvedAt" FROM "ListingIssue" WHERE id = 'stale-1'`))[0].resolvedAt)).toEqual(at(11))
    })

    it('没有卖家编号的店铺不适用；缺“商品刊登”角色（403）以不可重试的专用错误结束', async () => {
      expect(await doSync(null, at(12))).toEqual({ notApplicable: true, reason: 'SELLER_ID_MISSING', imported: 0 })
      const http = await import(/* @vite-ignore */ String('../../../worker/src/connectors/http-error'))
      const api = { search: vi.fn().mockRejectedValue(new http.UpstreamHttpError('forbidden', 403, undefined, 'api')) }
      await expect(doSync(api, at(12))).rejects.toMatchObject({ code: 'LISTING_ROLE_MISSING', retryable: false })
    })
  })

  describe('校验预览与刊登限制查询', () => {
    const client = (handler: (options: Json) => unknown) => ({ request: vi.fn(async (options: Json) => handler(options)) })
    const call = (record: Json, fake: unknown) =>
      run(() => dispatch.processListingWrite({ prisma: tenantDb }, fake, { tenantId, connection: { id: 'conn-lw' } }, storeId, { tenantId, listingRunId: record.id }, {}))
    const patches = [{ op: 'replace', attribute: 'item_name', values: ['新标题'] }]

    it('校验通过：写回通过结论与 30 分钟的有效期；请求用校验预览模式，不是正式提交', async () => {
      const record = await newRun({ kind: 'VALIDATE', sellerSku: 'SKU-1', productType: 'SHIRT', requestJson: JSON.stringify({ sku: 'SKU-1', productType: 'SHIRT', patches }) })
      const fake = client(() => ({ status: 'VALID', issues: [] }))
      expect(await call(record, fake)).toEqual({ validation: 'VALID', issues: 0 })
      const options = fake.request.mock.calls[0]![0]
      expect(options).toMatchObject({ method: 'PATCH', query: { mode: 'VALIDATION_PREVIEW' }, body: { productType: 'SHIRT' } })
      expect(options.path).toContain('SELLER-LW/SKU-1')
      const after = await runRow(record.id)
      expect(after).toMatchObject({ status: 'SUCCEEDED', validation: 'VALID', failureCode: null })
      expect(after.expiresAt.getTime() - after.finishedAt.getTime()).toBe(30 * 60_000)
    })

    it('校验没通过：存下亚马逊给的问题，没有有效期（不能用来提交）；响应无法识别按失败处理', async () => {
      const invalid = await newRun({ kind: 'VALIDATE', sellerSku: 'SKU-1', productType: 'SHIRT', requestJson: JSON.stringify({ patches }) })
      await call(
        invalid,
        client(() => ({ status: 'INVALID', issues: [{ code: '90220', severity: 'ERROR', message: '颜色不合法', attributeNames: ['color'] }] })),
      )
      expect(await runRow(invalid.id)).toMatchObject({
        status: 'SUCCEEDED',
        validation: 'INVALID',
        expiresAt: null,
        issuesJson: [{ code: '90220', severity: 'ERROR', message: '颜色不合法', attributeNames: ['color'] }],
      })
      const unknown = await newRun({ kind: 'VALIDATE', sellerSku: 'SKU-1', productType: 'SHIRT', requestJson: JSON.stringify({ patches }) })
      await expect(
        call(
          unknown,
          client(() => ({ foo: 'bar' })),
        ),
      ).rejects.toMatchObject({ code: 'LISTING_RESPONSE_UNRECOGNIZED' })
    })

    it('刊登限制：逐个 ASIN 查询；被拒绝的 ASIN 只记那一行；结果 1 小时后过期', async () => {
      const http = await import(/* @vite-ignore */ String('../../../worker/src/connectors/http-error'))
      const record = await newRun({ kind: 'RESTRICTIONS', requestJson: JSON.stringify({ asins: ['B0AAAAAAAA', 'B0BBBBBBBB', 'B0CCCCCCCC'], conditionType: 'used_good' }) })
      const fake = client(options => {
        if (options.query.asin === 'B0BBBBBBBB') throw new http.UpstreamHttpError('not found', 404, undefined, 'api')
        if (options.query.asin === 'B0AAAAAAAA')
          return { restrictions: [{ reasons: [{ reasonCode: 'APPROVAL_REQUIRED', message: '需要审核', links: [{ resource: 'https://sellercentral.amazon.com/apply' }] }] }] }
        return { restrictions: [] }
      })
      expect(await call(record, fake)).toEqual({ checked: 3, restricted: 1 })
      expect(fake.request.mock.calls[0]![0].query).toMatchObject({ conditionType: 'used_good', sellerId: 'SELLER-LW' })
      const after = await runRow(record.id)
      expect(after.status).toBe('SUCCEEDED')
      expect(after.expiresAt.getTime() - after.finishedAt.getTime()).toBe(60 * 60_000)
      expect(after.resultJson.rows.map((row: Json) => [row.asin, row.restricted, row.error])).toEqual([
        ['B0AAAAAAAA', true, null],
        ['B0BBBBBBBB', false, 'ASIN_NOT_FOUND'],
        ['B0CCCCCCCC', false, null],
      ])
      const page = await quality('tab=restrictions')
      expect(page.restrictionRows.map((row: Json) => [row.asin, row.restricted])).toEqual([
        ['B0AAAAAAAA', true],
        ['B0BBBBBBBB', false],
        ['B0CCCCCCCC', false],
      ])
      expect(page.restrictionRows[0].reasons[0]).toMatchObject({ code: 'APPROVAL_REQUIRED', links: [{ url: 'https://sellercentral.amazon.com/apply' }] })
    })
  })

  describe('修改刊登的写入流程', () => {
    const definition = () => workflow.createListingWriteWorkflow({ prisma: tenantDb, guardFor: (() => undefined) as never, secrets: {} as never })
    const ctx = (runId: string, responses: Json = {}) => ({
      tenantId,
      intent: { tenantId, connectionId: 'conn-lw', listingRunId: runId },
      request: {},
      responseOf: (index: number) => responses[index] ?? {},
    })
    const step = (index: number, runId: string, responses?: Json) => run(() => definition().steps[index]!.run(ctx(runId, responses) as never))
    const switchRow = (enabled: boolean) =>
      h.client.query(
        `INSERT INTO "IntegrationSwitch" (id, "tenantId", "switchKey", enabled, "updatedAt") VALUES ('sw-lw-update', $1, 'sw.listing.update', $2, now()) ON CONFLICT (id) DO UPDATE SET enabled = $2`,
        [tenantId, enabled],
      )

    it('开关已关闭：调用亚马逊之前就以不可重试错误结束，记录保持待处理', async () => {
      await switchRow(false)
      const record = await newRun({ kind: 'PATCH', sellerSku: 'SKU-1', productType: 'SHIRT', requestJson: JSON.stringify({ patches: [{ op: 'replace', attribute: 'color', values: ['Blue'] }] }) })
      await expect(step(0, record.id)).rejects.toMatchObject({ code: 'SWITCH_DISABLED', retryable: false })
      expect((await runRow(record.id)).status).toBe('PENDING')
    })

    it('已经成功的记录重放：不再调用亚马逊，直接认为完成', async () => {
      await switchRow(true)
      const done = await newRun({ kind: 'PATCH', sellerSku: 'SKU-1', productType: 'SHIRT', status: 'SUCCEEDED', requestJson: JSON.stringify({ patches: [] }) })
      expect(await step(0, done.id)).toMatchObject({ done: true })
      const reconcile = await run(() => definition().steps[0]!.reconcile!(ctx(done.id) as never))
      expect(reconcile).toMatchObject({ found: true })
    })

    it('回写：记录标为成功；该商品被修改属性的未解决问题与搜索抑制类标为“处理中”并关联任务；重放只做一次', async () => {
      const record = await newRun({
        kind: 'PATCH',
        sellerSku: 'SKU-1',
        productType: 'SHIRT',
        status: 'RUNNING',
        requestJson: JSON.stringify({ patches: [{ op: 'replace', attribute: 'color', values: ['Blue'] }] }),
      })
      await insertRow(h.client, 'ListingIssue', {
        id: 'other-attr',
        tenantId,
        sellerAccountId: storeId,
        sellerSku: 'SKU-1',
        issueKind: 'ISSUE',
        issueCode: '777',
        attributeName: 'size',
        severity: 'WARNING',
        message: '别的属性',
        firstSeenAt: at(2).toISOString(),
        lastSeenAt: at(2).toISOString(),
      })
      await step(1, record.id, { 0: { issues: [] } })
      expect(await runRow(record.id)).toMatchObject({ status: 'SUCCEEDED', failureCode: null })
      expect(await issueOf('SKU-1')).toMatchObject({ handlingStatus: 'IN_PROGRESS', handlingRunId: record.id })
      expect((await rows<Json>(`SELECT "handlingStatus" FROM "ListingIssue" WHERE id = 'other-attr'`))[0].handlingStatus).toBe('OPEN')
      const version = (await issueOf('SKU-1')).version
      await step(1, record.id, { 0: { issues: [] } })
      expect((await issueOf('SKU-1')).version).toBe(version)
      const data = await quality('status=IN_PROGRESS')
      expect(data.issueRows.map((row: Json) => row.status)).toEqual(['IN_PROGRESS'])
    })

    it('流程里找不到记录：不可重试错误', async () => {
      await expect(step(0, 'no-such-run')).rejects.toMatchObject({ code: 'LISTING_RUN_NOT_FOUND' })
    })
  })

  describe('批量任务的结果轮询', () => {
    const items = [
      { sku: 'SKU-1', productType: 'SHIRT', patches: [{ op: 'replace', attribute: 'color', values: ['Blue'] }] },
      { sku: 'SKU-2', productType: 'SHIRT', patches: [{ op: 'replace', attribute: 'size', values: ['M'] }] },
    ]
    const poll = (record: Json, status: Json, resultFile?: Json) => {
      const fake = {
        request: vi.fn(async (options: Json) => {
          if (options.path.endsWith('/documents/doc-1')) return { url: 'https://download/result', compressionAlgorithm: 'GZIP' }
          return status
        }),
      }
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(gzipSync(Buffer.from(JSON.stringify(resultFile ?? {}))))),
      )
      return run(() => dispatch.processListingWrite({ prisma: tenantDb }, fake, { tenantId, connection: { id: 'conn-lw' } }, storeId, { tenantId, listingRunId: record.id, poll: true }, {})).finally(
        () => vi.unstubAllGlobals(),
      )
    }

    it('没处理完：返回 pending，状态改为处理中并累计轮询次数；已经完成的记录不再处理', async () => {
      const record = await newRun({ kind: 'BATCH', status: 'SUBMITTED', feedId: 'feed-1', requestJson: JSON.stringify({ items }), itemCount: 2 })
      expect(await poll(record, { processingStatus: 'IN_PROGRESS' })).toMatchObject({ pending: true, feedId: 'feed-1' })
      expect(await runRow(record.id)).toMatchObject({ status: 'PROCESSING', pollCount: 1 })
      const finished = await newRun({ kind: 'BATCH', status: 'SUCCEEDED', feedId: 'feed-9', requestJson: JSON.stringify({ items }) })
      expect(await poll(finished, { processingStatus: 'IN_PROGRESS' })).toEqual({ done: true })
    })

    it('处理完成：逐个商品写结果；有错误的商品失败、其余成功（部分通过）；成功商品的问题标为处理中', async () => {
      await h.client.query(`UPDATE "ListingIssue" SET "handlingStatus" = 'OPEN', "handlingRunId" = NULL WHERE "sellerSku" = 'SKU-1'`)
      const record = await newRun({ kind: 'BATCH', status: 'PROCESSING', feedId: 'feed-2', requestJson: JSON.stringify({ items }), itemCount: 2 })
      const result = await poll(
        record,
        { processingStatus: 'DONE', resultFeedDocumentId: 'doc-1' },
        { issues: [{ messageId: 2, code: 'E1', severity: 'ERROR', message: '尺码不合法', attributeNames: ['size'] }] },
      )
      expect(result).toEqual({ done: true, accepted: 1, invalid: 1 })
      const after = await runRow(record.id)
      expect(after).toMatchObject({ status: 'PARTIAL', failureCode: null })
      expect(after.resultJson).toMatchObject({
        accepted: 1,
        invalid: 1,
        rows: [
          { sku: 'SKU-1', ok: true },
          { sku: 'SKU-2', ok: false },
        ],
      })
      expect(await issueOf('SKU-1')).toMatchObject({ handlingStatus: 'IN_PROGRESS', handlingRunId: record.id })
      const view = (await h.call(owner.token, 'GET', `/listings/runs/${record.id}`)).json.data
      expect(view).toMatchObject({ status: 'PARTIAL', summary: { accepted: 1, invalid: 1 } })
      expect(view.rows[1].issues[0]).toMatchObject({ message: '尺码不合法' })
    })

    it('全部有错误：整体失败；致命、取消与没有编号以不可重试错误结束；轮询超过上限以超时结束', async () => {
      const failed = await newRun({ kind: 'BATCH', status: 'PROCESSING', feedId: 'feed-3', requestJson: JSON.stringify({ items: items.slice(0, 1) }), itemCount: 1 })
      await poll(failed, { processingStatus: 'DONE', resultFeedDocumentId: 'doc-1' }, { issues: [{ messageId: 1, code: 'E1', severity: 'ERROR', message: '不合法' }] })
      expect(await runRow(failed.id)).toMatchObject({ status: 'FAILED', failureCode: 'LISTING_REQUEST_REJECTED' })
      const fatal = await newRun({ kind: 'BATCH', status: 'PROCESSING', feedId: 'feed-4', requestJson: JSON.stringify({ items }) })
      await expect(poll(fatal, { processingStatus: 'FATAL' })).rejects.toMatchObject({ code: 'FEED_FATAL', retryable: false })
      const noId = await newRun({ kind: 'BATCH', status: 'SUBMITTED', requestJson: JSON.stringify({ items }) })
      await expect(poll(noId, { processingStatus: 'DONE' })).rejects.toMatchObject({ code: 'FEED_ID_MISSING' })
      const noFile = await newRun({ kind: 'BATCH', status: 'PROCESSING', feedId: 'feed-5', requestJson: JSON.stringify({ items }) })
      await expect(poll(noFile, { processingStatus: 'DONE' })).rejects.toMatchObject({ code: 'FEED_RESULT_MISSING' })
      const late = await newRun({ kind: 'BATCH', status: 'PROCESSING', feedId: 'feed-6', pollCount: 239, requestJson: JSON.stringify({ items }) })
      await expect(poll(late, { processingStatus: 'IN_QUEUE' })).rejects.toMatchObject({ code: 'FEED_TIMEOUT' })
    })
  })

  describe('失败处置', () => {
    it('永久失败：未完成的记录标为失败并只留“来源+状态码”；已有结论的记录不改；缺记录编号或找不到记录时什么都不做', async () => {
      const pending = await newRun({ kind: 'VALIDATE', status: 'RUNNING', requestJson: JSON.stringify({}) })
      await run(() => dispatch.markListingRunFailed(tenantDb, tenantId, { listingRunId: pending.id }, 'SP_API_400_InvalidInput: secret details'))
      expect(await runRow(pending.id)).toMatchObject({ status: 'FAILED', failureCode: 'SP_API_400' })
      const done = await newRun({ kind: 'RESTRICTIONS', status: 'SUCCEEDED', requestJson: JSON.stringify({}) })
      await run(() => dispatch.markListingRunFailed(tenantDb, tenantId, { listingRunId: done.id }, 'SP_API_500_x'))
      expect((await runRow(done.id)).status).toBe('SUCCEEDED')
      await run(() => dispatch.markListingRunFailed(tenantDb, tenantId, {}, 'SP_API_500_x'))
      await run(() => dispatch.markListingRunFailed(tenantDb, tenantId, { listingRunId: 'missing' }, 'SP_API_500_x'))
    })

    it('修改刊登的失败：只有真正调用亚马逊的失败才计入开关的连续失败次数；校验预览的失败不计', async () => {
      await h.client.query(`UPDATE "IntegrationSwitch" SET "consecutiveFailures" = 0, enabled = true WHERE "switchKey" = 'sw.listing.update' AND "tenantId" = $1`, [tenantId])
      const validate = await newRun({ kind: 'VALIDATE', status: 'RUNNING', requestJson: JSON.stringify({}) })
      await run(() => dispatch.markListingRunFailed(tenantDb, tenantId, { listingRunId: validate.id }, 'SP_API_500_x'))
      const patch = await newRun({ kind: 'PATCH', status: 'RUNNING', requestJson: JSON.stringify({}) })
      await run(() => dispatch.markListingRunFailed(tenantDb, tenantId, { listingRunId: patch.id }, 'SP_API_500_x'))
      const local = await newRun({ kind: 'PATCH', status: 'RUNNING', requestJson: JSON.stringify({}) })
      await run(() => dispatch.markListingRunFailed(tenantDb, tenantId, { listingRunId: local.id }, 'LISTING_REQUEST_REJECTED'))
      const [row] = await rows<Json>(`SELECT "consecutiveFailures" FROM "IntegrationSwitch" WHERE "switchKey" = 'sw.listing.update' AND "tenantId" = $1`, [tenantId])
      expect(row.consecutiveFailures).toBe(1)
      expect(await runRow(local.id)).toMatchObject({ status: 'FAILED', failureCode: 'LISTING_REQUEST_REJECTED' })
    })
  })
})
