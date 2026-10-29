import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_BOX_NO_RULE, DEFAULT_LABEL_OPTIONS } from '@nova/api-contracts'
import { LocalDiskStorage, TenantObjectStore } from '@nova/storage'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runExport } from './run-export'

// 文档类导出（PDF）走导出任务的同一套流程：权限与范围按发起人此刻的状态复核、成功后写生成记录与审计、失败落到任务上。

const NOW = new Date('2026-12-14T08:00:00Z')
let root: string
let storage: LocalDiskStorage
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nova-label-export-'))
  storage = new LocalDiskStorage({ rootDir: root, signingKey: Buffer.alloc(32, 7), publicBaseUrl: 'http://localhost/storage' })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function amazonPdf(pages: number) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < pages; index += 1) doc.addPage([288, 432]).drawText(`FBA-${index}`, { x: 20, y: 400, size: 12, font })
  return Buffer.from(await doc.save())
}
const boxPayload = (over: Record<string, unknown> = {}) => ({
  planId: 'p1',
  shipmentRowId: 'sh1',
  shipmentLabel: 'FBA15ABC',
  destinationFc: 'ONT8',
  planName: 'Autumn',
  planNo: 'P0001',
  baseLabelJobId: 'lj1',
  templateId: 'tpl1',
  templateName: 'Default',
  paper: 'THERMAL_4X6',
  options: DEFAULT_LABEL_OPTIONS,
  boxNoRule: DEFAULT_BOX_NO_RULE,
  boxCount: 2,
  startNumber: 1,
  facts: null,
  notes: [],
  ...over,
})
const jobRow = (kind: string, filterJson: unknown, over: Record<string, unknown> = {}) => ({
  id: 'e1',
  tenantId: 't1',
  kind,
  format: 'PDF',
  status: 'QUEUED',
  filterJson,
  requestedBy: 'u1',
  createdAt: new Date('2026-12-14T00:00:00Z'),
  expiresAt: new Date('2026-12-21T00:00:00Z'),
  fieldPolicySnapshot: { columns: ['pdf'], scope: { unrestricted: true, storeIds: [] } },
  ...over,
})

function dbFor(job: Record<string, unknown>, over: { permissions?: string[]; baseKey?: string | null; scopes?: unknown[]; sellerAccountId?: string } = {}) {
  const db: Record<string, any> = {
    exportJob: { findFirst: vi.fn().mockResolvedValue(job), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    membership: { findFirst: vi.fn().mockResolvedValue({ id: 'm1', role: { permissions: over.permissions ?? ['export.create', 'inbound.read'], system: true, version: 2, fieldPermissions: [] } }) },
    membershipScope: { findMany: vi.fn().mockResolvedValue(over.scopes ?? [{ legalEntityId: null, sellerAccountId: null }]) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
    fbaInboundPlan: { findFirst: vi.fn().mockResolvedValue({ id: 'p1', sellerAccountId: over.sellerAccountId ?? 's1' }) },
    fbaInboundShipment: { findFirst: vi.fn().mockResolvedValue({ id: 'sh1' }) },
    labelPrintJob: { findFirst: vi.fn().mockResolvedValue(over.baseKey === null ? null : { objectKey: over.baseKey ?? 'missing' }) },
    labelTemplate: { findFirst: vi.fn().mockResolvedValue({ id: 'tpl1' }) },
    labelPrintLog: { create: vi.fn().mockImplementation(async args => args) },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditEvent: { create: vi.fn().mockImplementation(async args => args) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  }
  return db
}
const deps = (db: Record<string, any>, labelFontPath?: string) => ({ db: db as never, storage, now: () => NOW, labelFontPath })
const lastUpdate = (db: Record<string, any>) => db.exportJob.updateMany.mock.calls.at(-1)[0]
const auditActions = (db: Record<string, any>) => db.auditEvent.create.mock.calls.map((call: any[]) => call[0].data.action)

async function storeBase(pages: number) {
  const store = new TenantObjectStore(storage, 't1', () => NOW)
  return (await store.put({ domain: 'inbound-labels', name: 'base.pdf' }, await amazonPdf(pages), { contentType: 'application/pdf' })).key
}
const read = async (key: string) => {
  const chunks: Buffer[] = []
  for await (const chunk of await storage.openRead(key)) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

describe('标签 PDF 导出', () => {
  it('自定义箱标签：读取亚马逊箱标签、生成 PDF 存进导出文件；任务完成，写生成记录与审计，通知按“张”计数', async () => {
    const db = dbFor(jobRow('inbound-box-labels', boxPayload()), { baseKey: await storeBase(2) })
    const outcome = await runExport(deps(db), 't1', 'e1')
    expect(outcome).toMatchObject({ status: 'DONE', rows: 2 })
    const done = lastUpdate(db)
    expect(done.data).toMatchObject({ status: 'DONE', rowCount: 2, errorCode: null })
    expect(done.data.fileKey).toMatch(/^tenants\/t1\/exports\//)
    const out = await PDFDocument.load(await read(done.data.fileKey))
    expect(out.getPageCount()).toBe(4)
    expect(db.labelPrintLog.create.mock.calls[0][0].data).toMatchObject({
      tenantId: 't1',
      planId: 'p1',
      shipmentId: 'sh1',
      templateId: 'tpl1',
      kind: 'BOX_CUSTOM',
      labelCount: 2,
      exportJobId: 'e1',
      printedBy: 'u1',
    })
    expect(auditActions(db)).toEqual(['EXPORT_COMPLETED', 'LABEL_PDF_GENERATED'])
    expect(db.notification.createMany.mock.calls[0][0].data[0].body).toContain('共 2 张')
  })

  it('商品标签：不需要亚马逊文件，按快照生成；记录里没有模板与货件时为空', async () => {
    const payload = { planId: 'p1', shipmentRowId: null, size: 'THERMAL_50X30', showTitle: false, showCondition: true, lines: [{ sku: 'S1', fnsku: 'X001ABCDEF', title: null, quantity: 3 }] }
    const db = dbFor(jobRow('inbound-item-labels', payload))
    const outcome = await runExport(deps(db), 't1', 'e1')
    expect(outcome).toMatchObject({ status: 'DONE', rows: 3 })
    expect((await PDFDocument.load(await read(lastUpdate(db).data.fileKey))).getPageCount()).toBe(3)
    expect(db.labelPrintLog.create.mock.calls[0][0].data).toMatchObject({ kind: 'ITEM', labelCount: 3, shipmentId: null, templateId: null })
  })

  it('权限在排队期间被收回（没有入仓查看权限）：任务失败，不读文件、不写生成记录', async () => {
    const db = dbFor(jobRow('inbound-box-labels', boxPayload()), { permissions: ['export.create'], baseKey: await storeBase(2) })
    expect(await runExport(deps(db), 't1', 'e1')).toEqual({ status: 'FAILED', code: 'EXPORT_PERMISSION_REVOKED' })
    expect(db.labelPrintJob.findFirst).not.toHaveBeenCalled()
    expect(db.labelPrintLog.create).not.toHaveBeenCalled()
  })

  it('店铺范围被收窄、计划所在店铺已不在范围内：失败（LABEL_SCOPE_DENIED）', async () => {
    const db = dbFor(jobRow('inbound-box-labels', boxPayload()), { baseKey: await storeBase(2), scopes: [{ legalEntityId: null, sellerAccountId: 's1' }], sellerAccountId: 's9' })
    expect(await runExport(deps(db), 't1', 'e1')).toEqual({ status: 'FAILED', code: 'LABEL_SCOPE_DENIED' })
    expect(lastUpdate(db).data).toMatchObject({ status: 'FAILED', errorCode: 'LABEL_SCOPE_DENIED', fileKey: null })
  })

  it('作为底的亚马逊文件不存在或已被清理：失败（LABEL_BASE_MISSING）', async () => {
    const noJob = dbFor(jobRow('inbound-box-labels', boxPayload()), { baseKey: null })
    expect(await runExport(deps(noJob), 't1', 'e1')).toEqual({ status: 'FAILED', code: 'LABEL_BASE_MISSING' })
    const gone = dbFor(jobRow('inbound-box-labels', boxPayload()), { baseKey: 'tenants/t1/inbound-labels/gone.pdf' })
    expect(await runExport(deps(gone), 't1', 'e1')).toEqual({ status: 'FAILED', code: 'LABEL_BASE_MISSING' })
  })

  it('页数与箱数对不上、含中文没有字体、任务内容损坏：各自失败并带原因码', async () => {
    const mismatch = dbFor(jobRow('inbound-box-labels', boxPayload({ boxCount: 3 })), { baseKey: await storeBase(2) })
    expect(await runExport(deps(mismatch), 't1', 'e1')).toEqual({ status: 'FAILED', code: 'LABEL_PAGE_MISMATCH' })
    const font = dbFor(jobRow('inbound-box-labels', boxPayload({ planName: '秋季补货', options: { ...DEFAULT_LABEL_OPTIONS, taskNamePage: true } })), { baseKey: await storeBase(2) })
    expect(await runExport(deps(font), 't1', 'e1')).toEqual({ status: 'FAILED', code: 'LABEL_FONT_MISSING' })
    const broken = dbFor(jobRow('inbound-box-labels', { planId: 'p1' }))
    expect(await runExport(deps(broken), 't1', 'e1')).toEqual({ status: 'FAILED', code: 'LABEL_JOB_INVALID' })
    expect(auditActions(broken)).toEqual(['EXPORT_FAILED'])
  })
})
