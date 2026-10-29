import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 货件接收与差异（P2a-13，真实数据库 + 完整应用）：
// 迁移升级与回滚、差异与机会的检查约束；列表补充列（赔付状态、差异天数、不合规问题数“尚未接入”与有数据）、
// 差异详情（差异原因、不合规问题、赔付任务与时限）、数据范围、证据附件与审计、按运营中心的接收时长统计与回写补货策略。

type Member = { userId: string; token: string }
const TARGET = '20261024040000_receiving_discrepancy'
const DAY = 86_400_000
// 用 ISO 文字写入：列是不带时区的时间戳，直接传 Date 会按本机时区换算而偏移
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const root = mkdtempSync(join(tmpdir(), 'nova-receiving-'))
const saved = { ...process.env }

const policyBody = {
  level: 'TENANT',
  levelRef: 'ALL',
  expectedVersionNo: 0,
  leadTimeDays: 30,
  awdLeadTimeDays: null,
  safetyDays: 14,
  coverageDays: 60,
  redundancyMultiplier: 1.5,
  inboundCounted: ['WORKING', 'SHIPPED'],
  agingFromDays: 271,
  changeReason: '初始策略',
  productionDays: 10,
  domesticDays: 3,
  receivingDays: 7,
  serviceLevel: 0.95,
  transportPreference: 'AUTO',
  transportOptions: [{ mode: 'SEA', transitDays: 30, unitCost: 0.5 }],
  casePackQty: 10,
  moq: 100,
  minOrderValue: null,
}

describe('接收差异表迁移（P2a-13）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('receiving_migrate')
    client = await db.connect('receiving_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0].found as boolean

  it('升级建两张表、回滚全部删除、再次升级闭环成功；差异与机会的取值与数量由数据库约束', async () => {
    expect(await exists('ReceivingDiscrepancy')).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists('ReceivingDiscrepancy')).toBe(true)
    expect(await exists('ReimbursementOpportunity')).toBe(true)
    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await exists('ReceivingDiscrepancy')).toBe(false)
    expect(await exists('ReimbursementOpportunity')).toBe(false)
    await applyMigrations(client, { only: TARGET })

    const ids = await seedTenant(client, 'rcv-mig')
    const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, shipmentRef: 'SH-1', sku: 'A', firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }
    let n = 0
    const row = (over: Record<string, unknown>) => insertRow(client, 'ReceivingDiscrepancy', { id: `rd-mig-${++n}`, ...base, ...over })
    await row({ kind: 'SHORT', source: 'RECEIPT', qty: 3 })
    await expect(row({ kind: 'SHORT', source: 'RECEIPT', qty: 4 })).rejects.toMatchObject({ code: '23505' })
    await expect(row({ sku: 'B', kind: 'SHORT', source: 'RECEIPT', qty: null })).rejects.toMatchObject({ code: '23514' })
    await expect(row({ sku: 'B', kind: 'SHORT', source: 'RECEIPT', qty: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(row({ sku: 'B', kind: 'SHORT', source: 'REPORT', qty: 1 })).rejects.toMatchObject({ code: '23514' })
    await expect(row({ sku: 'B', kind: 'NONCOMPLIANCE', source: 'RECEIPT' })).rejects.toMatchObject({ code: '23514' })
    await expect(row({ sku: 'B', kind: 'DAMAGED', source: 'RECEIPT', qty: 1 })).rejects.toMatchObject({ code: '23514' })
    // 不合规：数量与金额可以没有（报告没给不是 0）；同一问题类型唯一，不同问题类型可并存
    const first = await row({ sku: 'N', kind: 'NONCOMPLIANCE', source: 'REPORT', problemKey: 'LABEL', problemType: 'LABEL' })
    expect(first.qty).toBeNull()
    expect(first.amount).toBeNull()
    await row({ sku: 'N', kind: 'NONCOMPLIANCE', source: 'REPORT', problemKey: 'PREP', problemType: 'PREP' })
    await expect(row({ sku: 'N', kind: 'NONCOMPLIANCE', source: 'REPORT', problemKey: 'PREP' })).rejects.toMatchObject({ code: '23505' })
    await expect(row({ sku: 'M', kind: 'NONCOMPLIANCE', source: 'REPORT', amount: -1 })).rejects.toMatchObject({ code: '23514' })

    const opp = (over: Record<string, unknown>) =>
      insertRow(client, 'ReimbursementOpportunity', {
        id: `ro-mig-${++n}`,
        tenantId: ids.tenantId,
        sellerAccountId: ids.sellerAccountId,
        ruleCode: 'INBOUND_DISCREPANCY',
        dedupKey: 'SH-1:A',
        evidenceRefsJson: '[]',
        ...over,
      })
    const created = await opp({})
    expect(created).toMatchObject({ status: 'PENDING', estimatedAmount: null })
    await expect(opp({})).rejects.toMatchObject({ code: '23505' })
    await expect(opp({ dedupKey: 'x', ruleCode: 'MADE_UP' })).rejects.toMatchObject({ code: '23514' })
    await expect(opp({ dedupKey: 'y', status: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    await expect(opp({ dedupKey: 'z', estimatedAmount: -1 })).rejects.toMatchObject({ code: '23514' })
  })
})

describe('货件接收与差异（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerAccountId: string
  let secondSellerId: string
  let owner: Member
  let readOnly: Member
  let scoped: Member
  let noPolicy: Member
  let other: Member
  let seq = 0

  const call = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, body === undefined ? {} : { body })
  const ok = async (member: Member, method: string, path: string, body?: unknown) => {
    const res = await call(member, method, path, body)
    expect(res.status, `${method} ${path} → ${JSON.stringify(res.json)}`).toBeLessThan(300)
    return res.json.data
  }

  /** 一个计划与一个货件（含明细）；数量按“应发、已收”成对给出。 */
  async function shipment(
    code: string,
    over: { status?: string; fc?: string; items?: Array<[string, number, number | null]>; sellerId?: string; firstAt?: string | null; doneAt?: string | null; confirm?: string | null } = {},
  ) {
    const planId = `plan-${code}`
    await insertRow(h.client, 'FbaInboundPlan', { id: planId, tenantId, sellerAccountId: over.sellerId ?? sellerAccountId, name: `计划 ${code}`, stage: 'RECEIVING' })
    const row = await insertRow(h.client, 'FbaInboundShipment', {
      id: `ibs-${code}`,
      planId,
      shipmentId: `SH-${code}`,
      shipmentConfirmationId: over.confirm === undefined ? `FBA${code}` : over.confirm,
      status: over.status ?? 'CLOSED',
      destinationFc: over.fc ?? 'ONT8',
      receivedFirstAt: over.firstAt === undefined ? ago(20) : over.firstAt,
      receivedDoneAt: over.doneAt === undefined ? ago(18) : over.doneAt,
    })
    for (const [sku, shipped, received] of over.items ?? [['SKU-A', 10, 10]]) {
      await insertRow(h.client, 'ShipmentItem', { id: `si-${++seq}`, tenantId, planId, shipmentId: `SH-${code}`, sku, shippedQty: shipped, receivedQty: received })
    }
    return row.id as string
  }
  const discrepancy = (code: string, sku: string, kind: string, over: Record<string, unknown> = {}) =>
    insertRow(h.client, 'ReceivingDiscrepancy', {
      id: `rd-${++seq}`,
      tenantId,
      sellerAccountId,
      shipmentRef: `SH-${code}`,
      sku,
      kind,
      qty: kind === 'NONCOMPLIANCE' ? null : 3,
      source: kind === 'NONCOMPLIANCE' ? 'REPORT' : 'RECEIPT',
      firstSeenAt: ago(10),
      lastSeenAt: ago(1),
      ...over,
    })
  const opportunity = (code: string, sku: string, status: string, over: Record<string, unknown> = {}) =>
    insertRow(h.client, 'ReimbursementOpportunity', {
      id: `ro-${++seq}`,
      tenantId,
      sellerAccountId,
      ruleCode: 'INBOUND_DISCREPANCY',
      dedupKey: `SH-${code}:${sku}`,
      evidenceRefsJson: JSON.stringify([{ kind: 'SHIPMENT', id: `ibs-${code}`, label: `货件 SH-${code}` }]),
      status,
      ...over,
    })

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local'
    process.env.STORAGE_LOCAL_DIR = root
    process.env.STORAGE_SIGNING_KEY = 'z'.repeat(48)
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'receiving', db })
    const a = await h.createTenant('rcv-a')
    tenantId = a.tenantId
    sellerAccountId = a.sellerAccountId
    secondSellerId = (await insertRow(h.client, 'SellerAccount', { id: 'seller-rcv-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-RCV-2' })).id
    const b = await h.createTenant('rcv-b')
    owner = await h.createMember(tenantId, 'rcv-owner', ['*'])
    readOnly = await h.createMember(tenantId, 'rcv-readonly', ['inbound.read'])
    scoped = await h.createMember(tenantId, 'rcv-scoped', ['inbound.read', 'inbound.plan.write', 'replenishment.policy.write'], { scopes: [{ sellerAccountId: secondSellerId }] })
    noPolicy = await h.createMember(tenantId, 'rcv-nopolicy', ['inbound.read', 'inbound.plan.write'])
    other = await h.createMember(b.tenantId, 'rcv-other', ['*'])
  })
  afterAll(async () => {
    process.env = saved
    await h?.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('列表：赔付状态、差异天数、不合规问题数（报告未同步为尚未接入）；筛选与权限', async () => {
    await shipment('A', { items: [['SKU-A', 10, 7]], firstAt: ago(62), doneAt: ago(60) }) // 少收 3，机会待处理
    await discrepancy('A', 'SKU-A', 'SHORT')
    await opportunity('A', 'SKU-A', 'PENDING', { estimatedAmount: '30.000000', currency: 'USD' })
    await shipment('B', { status: 'RECEIVING', doneAt: null, items: [['SKU-A', 10, 4]] }) // 还没关闭：不判断
    await shipment('C', { items: [['SKU-A', 10, 10]] }) // 收齐
    await shipment('D', { items: [['SKU-A', 10, 8]] }) // 少收 2，还在等待期：没有机会
    await discrepancy('D', 'SKU-A', 'SHORT', { qty: 2, firstSeenAt: ago(3) })
    await shipment('E', { fc: 'LAX9', items: [['SKU-A', 5, 6]] }) // 多收：不产生赔付
    await discrepancy('E', 'SKU-A', 'OVER', { qty: 1 })

    const list = await ok(owner, 'GET', '/inbound/shipments?pageSize=50')
    const by = Object.fromEntries(list.items.map((item: { shipmentId: string; receiving: unknown }) => [item.shipmentId, item.receiving]))
    expect(by['SH-A']).toMatchObject({ claimState: 'PENDING', discrepancyDays: 10, noncomplianceCount: null })
    expect(by['SH-B']).toMatchObject({ claimState: 'NOT_JUDGED', discrepancyDays: null })
    expect(by['SH-C']).toMatchObject({ claimState: 'NONE', discrepancyDays: null })
    expect(by['SH-D']).toMatchObject({ claimState: 'WAITING', discrepancyDays: 3 })
    expect(by['SH-E']).toMatchObject({ claimState: 'NONE' })

    const only = await ok(owner, 'GET', '/inbound/shipments?discrepancy=1&pageSize=50')
    expect(only.items.map((item: { shipmentId: string }) => item.shipmentId).sort()).toEqual(['SH-A', 'SH-D', 'SH-E'])
    const fc = await ok(owner, 'GET', '/inbound/shipments?destinationFc=LAX9')
    expect(fc.items.map((item: { shipmentId: string }) => item.shipmentId)).toEqual(['SH-E'])
    expect((await call(owner, 'GET', '/inbound/shipments?discrepancy=0')).status).toBe(422)
    expect((await call(other, 'GET', `/inbound/shipments/ibs-A`)).status).toBe(404)
    expect((await ok(other, 'GET', '/inbound/shipments')).items).toEqual([])
  })

  it('不合规报告同步成功后才显示数量：报告里的货件编号可以是确认号；差异原因取自同一 SKU 的不合规问题', async () => {
    await discrepancy('A', 'SKU-A', 'NONCOMPLIANCE', { shipmentRef: 'FBAA', problemKey: 'LABEL', problemType: 'LABELING_ERROR', amount: '3.500000', currency: 'USD' })
    await discrepancy('A', 'SKU-X', 'NONCOMPLIANCE', { shipmentRef: 'FBAA', problemKey: 'PREP', problemType: 'PREP_ERROR' })
    const before = await ok(owner, 'GET', '/inbound/shipments?q=SH-A')
    expect(before.items[0].receiving.noncomplianceCount).toBe(2) // 已有记录就一定是接入过的
    const detail = await ok(owner, 'GET', '/inbound/shipments/ibs-A/discrepancies')
    expect(detail.rows).toEqual([expect.objectContaining({ sku: 'SKU-A', shippedQty: 10, receivedQty: 7, discrepancyQty: 3, state: 'SHORT', reason: 'LABELING_ERROR' })])
    expect(detail.compliance.state).toBe('OK')
    expect(detail.compliance.items.map((item: { sku: string }) => item.sku).sort()).toEqual(['SKU-A', 'SKU-X'])
    expect(detail.compliance.items.find((item: { sku: string }) => item.sku === 'SKU-A')).toMatchObject({ problemType: 'LABELING_ERROR', amount: 3.5, currency: 'USD', qty: null })
    expect(detail.claims.state).toBe('OK')
    expect(detail.claims.items).toEqual([
      expect.objectContaining({ ruleCode: 'INBOUND_DISCREPANCY', ruleLabel: '入仓差异', sku: 'SKU-A', status: 'PENDING', qty: 3, estimatedAmount: 30, currency: 'USD' }),
    ])
    expect(detail.claims.items[0].evidence[0]).toMatchObject({ kind: 'SHIPMENT', id: 'ibs-A' })
    expect(detail.claims.window).toMatchObject({ state: 'OPEN' })
  })

  it('详情：没关闭的货件不判差异也不给赔付任务；没有同步过不合规报告写“尚未接入”；没有估算金额是空不是 0', async () => {
    const waiting = await ok(owner, 'GET', '/inbound/shipments/ibs-B/discrepancies')
    expect(waiting).toMatchObject({ closed: false, compliance: { state: 'NOT_CONNECTED', items: [] }, claims: { state: 'NOT_JUDGED', items: [], window: null } })
    expect(waiting.rows[0]).toMatchObject({ discrepancyQty: null, state: 'PENDING', reason: null })
    await h.client.query(
      `INSERT INTO "DataFreshness" (id, "tenantId", "sellerAccountId", "sourceKey", "lastAttemptAt", "lastSuccessAt", status, "updatedAt") VALUES ('df-rcv', $1, $2, 'rpt.inbound-noncompliance', now(), now(), 'NORMAL', now())`,
      [tenantId, sellerAccountId],
    )
    const synced = await ok(owner, 'GET', '/inbound/shipments/ibs-C/discrepancies')
    expect(synced.compliance).toMatchObject({ state: 'OK', items: [] }) // 同步过且没有记录：尚无记录，不是尚未接入
    expect((await ok(owner, 'GET', '/inbound/shipments?q=SH-C')).items[0].receiving.noncomplianceCount).toBe(0)
    await opportunity('D', 'SKU-A', 'PENDING')
    const noCost = await ok(owner, 'GET', '/inbound/shipments/ibs-D/discrepancies')
    expect(noCost.claims.items[0]).toMatchObject({ estimatedAmount: null, currency: null, status: 'PENDING' })
  })

  it('数据范围：只授权第二个店铺的成员看不到第一个店铺的货件，也不能传证据', async () => {
    expect((await call(scoped, 'GET', '/inbound/shipments/ibs-A')).status).toBe(404)
    expect((await call(scoped, 'GET', '/inbound/shipments/ibs-A/discrepancies')).status).toBe(404)
    expect((await call(scoped, 'GET', '/inbound/shipments/ibs-A/attachments')).status).toBe(404)
    expect((await call(scoped, 'POST', '/inbound/shipments/ibs-A/attachments', { fileName: 'a.txt', contentType: 'text/plain', sizeBytes: 1 })).status).toBe(404)
    await shipment('S', { sellerId: secondSellerId })
    expect((await ok(scoped, 'GET', '/inbound/shipments')).items.map((item: { shipmentId: string }) => item.shipmentId)).toEqual(['SH-S'])
  })

  it('证据附件与审计：上传、下载、审计里能看到上传；只读成员不能传；别的企业 404', async () => {
    const id = 'ibs-A'
    expect((await call(readOnly, 'POST', `/inbound/shipments/${id}/attachments`, { fileName: 'a.txt', contentType: 'text/plain', sizeBytes: 1 })).status).toBe(403)
    expect((await call(owner, 'POST', `/inbound/shipments/${id}/attachments`, { fileName: 'a.exe', contentType: 'application/x-msdownload', sizeBytes: 10 })).status).toBe(422)
    const content = 'packing list'
    const ticket = await ok(owner, 'POST', `/inbound/shipments/${id}/attachments`, { fileName: 'packing.txt', contentType: 'text/plain', sizeBytes: content.length })
    const token = (ticket.uploadUrl as string).slice((ticket.uploadUrl as string).lastIndexOf('/') + 1)
    const put = await fetch(`${h.baseUrl}/api/v1/storage/local/${token}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: content })
    expect(put.status).toBeLessThan(300)
    const confirmed = await ok(owner, 'POST', `/inbound/shipments/${id}/attachments/confirm`, { objectKey: ticket.objectKey, fileName: 'packing.txt', contentType: 'text/plain' })
    expect(confirmed).toMatchObject({ fileName: 'packing.txt', sizeBytes: content.length })
    expect(await ok(readOnly, 'GET', `/inbound/shipments/${id}/attachments`)).toHaveLength(1)
    expect((await ok(owner, 'GET', `/inbound/shipments/${id}/attachments/${confirmed.id}/download`)).url).toContain('http')
    expect((await call(other, 'GET', `/inbound/shipments/${id}/attachments/${confirmed.id}/download`)).status).toBe(404)
    const audit = await ok(owner, 'GET', `/inbound/shipments/${id}/audit`)
    expect(audit.map((row: { action: string }) => row.action)).toContain('ATTACHMENT_ADDED')
    expect((await call(other, 'GET', `/inbound/shipments/${id}/audit`)).status).toBe(404)
  })

  it('接收时长统计：按运营中心分组，样本不足不建议回写；回写取 p90 并写成新的策略版本', async () => {
    // 同一运营中心 6 个已关闭货件：接收时长 1、1、2、2、3、9 天
    const spans = [1, 1, 2, 2, 3, 9]
    for (const [index, span] of spans.entries()) await shipment(`T${index}`, { fc: 'PHX7', firstAt: ago(40), doneAt: ago(40 - span) })
    const before = await ok(owner, 'GET', '/inbound/receiving/stats')
    const phx = before.rows.find((row: { destinationFc: string }) => row.destinationFc === 'PHX7')
    expect(phx).toMatchObject({ sampleCount: 6, p50Days: 2, p90Days: 9, minDays: 1, maxDays: 9 })
    expect(before.rows.find((row: { destinationFc: string }) => row.destinationFc === 'LAX9').applyBlocked).toContain('样本不足')
    expect(phx.applyBlocked).toContain('策略尚未配置')
    expect(before.overall.sampleCount).toBeGreaterThanOrEqual(6)
    expect(before.policyVersionNo).toBeNull()
    expect((await call(owner, 'POST', '/inbound/receiving/stats/apply', { destinationFc: 'PHX7', expectedVersionNo: 1 })).status).toBe(409)

    await ok(owner, 'PUT', '/replenishment/policies', policyBody)
    expect((await call(noPolicy, 'POST', '/inbound/receiving/stats/apply', { destinationFc: 'PHX7', expectedVersionNo: 1 })).status).toBe(403)
    expect((await call(scoped, 'POST', '/inbound/receiving/stats/apply', { destinationFc: 'PHX7', expectedVersionNo: 1 })).status).toBe(403) // 范围不是全部店铺
    expect((await call(owner, 'POST', '/inbound/receiving/stats/apply', { destinationFc: 'PHX7', expectedVersionNo: 7 })).status).toBe(409)
    expect((await call(owner, 'POST', '/inbound/receiving/stats/apply', { destinationFc: 'LAX9', expectedVersionNo: 1 })).status).toBe(409) // 样本不足
    const applied = await ok(owner, 'POST', '/inbound/receiving/stats/apply', { destinationFc: 'PHX7', expectedVersionNo: 1 })
    expect(applied).toMatchObject({ versionNo: 2, receivingDays: 9, previousDays: 7, scopeLabel: 'PHX7' })
    const rows = (
      await h.client.query(`SELECT "versionNo", "receivingDays", "leadTimeDays", "changeReason" FROM "ReplenishmentPolicy" WHERE "tenantId" = $1 AND level = 'TENANT' ORDER BY "versionNo"`, [tenantId])
    ).rows
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ receivingDays: 9, leadTimeDays: 30 })
    expect(rows[1].changeReason).toContain('入仓接收时长回写')
    expect((await ok(owner, 'GET', '/inbound/receiving/stats')).policyReceivingDays).toBe(9)
    expect((await ok(other, 'GET', '/inbound/receiving/stats')).rows).toEqual([])
  })
})
