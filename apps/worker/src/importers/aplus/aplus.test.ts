import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NonRetryableError } from '@nova/workflow'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { AplusApi } from '../../connectors/aplus-api'
import { UpstreamHttpError } from '../../connectors/http-error'
import type { ImportContext } from '../../types'
import { fakeAplusDb } from './fake-db.test-helper'
import { syncAplus } from './sync'

// A+ 内容同步器（P4-14）：用内存替身与假接口覆盖——首次同步写内容、关联、发布时间与审核事件；重复同步不重复写事件；状态变化写新事件；
// 有写入在途就跳过；不认识的状态保持原值；发布记录每次最多查 N 个 ASIN 且上线时间为空的优先；403 → APL_ROLE_MISSING；不删除亚马逊侧已经没有的内容。
// 真实库的行级安全与唯一约束由 API 侧的真实库测试与迁移覆盖。

const FIXTURES = join(__dirname, '../../../fixtures/aplus')
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const NOW = new Date('2026-10-25T00:00:00.000Z')
const upstream = (status: number) => new UpstreamHttpError(`SP_API_${status}_x`, status, undefined, 'api')

const DETAILS: Record<string, string> = { 'KEY-DRAFT': 'detail-draft.json', 'KEY-APPROVED': 'detail-approved.json', 'KEY-REJECTED': 'detail-rejected.json' }

function setup(overrides: Partial<Record<'listContents' | 'getContent' | 'listAsins' | 'listPublishRecords', (...args: string[]) => Promise<unknown>>> = {}) {
  const db = fakeAplusDb()
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger
  const ctx: ImportContext = { prisma: db.prisma, logger }
  const api = {
    listContents: vi.fn(overrides.listContents ?? (async (token?: string) => fixture(token === 'page-2' ? 'list-page2.json' : 'list-page1.json'))),
    getContent: vi.fn(overrides.getContent ?? (async (key: string) => fixture(DETAILS[key]))),
    listAsins: vi.fn(overrides.listAsins ?? (async () => fixture('asins.json'))),
    listPublishRecords: vi.fn(overrides.listPublishRecords ?? (async () => fixture('publish-records.json'))),
  }
  const run = (options = {}) => syncAplus(ctx, api as unknown as AplusApi, scope, { now: NOW, ...options })
  return { ...db, api, logger, run }
}
const byKey = (db: ReturnType<typeof setup>, key: string) => db.contents.rows.find(row => row.contentReferenceKey === key)!

describe('首次同步', () => {
  it('写内容、关联 ASIN、上线时间与审核事件；状态按映射，已批准且有上线时间记为已发布；不动 version', async () => {
    const db = setup()
    const result = await db.run()
    expect(result).toMatchObject({ imported: 3, created: 3, updated: 0, skippedBusy: 0, skippedInvalid: 0, asinRows: 9, truncated: false })
    expect(db.contents.rows.map(row => [row.contentReferenceKey, row.status])).toEqual([
      ['KEY-DRAFT', 'DRAFT'],
      ['KEY-APPROVED', 'PUBLISHED'],
      ['KEY-REJECTED', 'REJECTED'],
    ])
    const draft = byKey(db, 'KEY-DRAFT')
    expect(draft).toMatchObject({
      name: 'Summer launch',
      contentType: 'EBC',
      locale: 'en-US',
      asinCount: 3,
      rejectionReason: null,
      lastSyncedAt: NOW,
      amazonUpdatedAt: new Date('2026-10-20T08:00:00Z'),
    })
    expect(draft.draftJson).toEqual({ contentModuleList: [expect.objectContaining({ contentModuleType: 'STANDARD_TEXT' })] })
    expect(draft).not.toHaveProperty('version') // 由数据库默认值给 1，同步器从不写
    expect(byKey(db, 'KEY-APPROVED')).toMatchObject({ contentType: 'EMC', publishedAt: new Date('2026-10-19T00:00:00Z') })
    expect(byKey(db, 'KEY-REJECTED').rejectionReason).toBe('Image contains price information (see guidelines).')
    expect(db.relations.rows.filter(row => row.contentId === byKey(db, 'KEY-APPROVED').id).every(row => row.publishedAt?.getTime() === Date.parse('2026-10-19T00:00:00Z'))).toBe(true)
    expect(db.relations.rows.filter(row => row.contentId === draft.id).every(row => row.publishedAt === undefined)).toBe(true)
    expect(db.events.rows.map(row => [row.status, row.source, row.message, row.occurredAt.toISOString()])).toEqual([
      ['DRAFT', 'SYNC', null, '2026-10-20T08:00:00.000Z'],
      ['PUBLISHED', 'SYNC', null, '2026-10-18T08:00:00.000Z'],
      ['REJECTED', 'SYNC', 'Image contains price information (see guidelines).', '2026-10-22T08:00:00.000Z'],
    ])
    expect(db.api.listContents).toHaveBeenCalledTimes(2) // 跟着下一页令牌翻页
  })

  it('接口没给更新时间：事件的发生时间取同步时间', async () => {
    const db = setup({
      listContents: async () => ({ contentMetadataRecords: [{ contentReferenceKey: 'KEY-DRAFT', contentMetadata: { name: 'N', status: 'DRAFT' } }] }),
      getContent: async () => ({ contentRecord: { contentMetadata: { name: 'N', status: 'DRAFT' } } }),
    })
    await db.run()
    expect(db.events.rows[0].occurredAt).toEqual(NOW)
    expect(byKey(db, 'KEY-DRAFT').draftJson).toBeUndefined() // 没返回模块：不写（保持数据库默认值），不拿空列表顶替
  })
})

describe('再次同步', () => {
  it('同一状态不重复写事件；保留已有上线时间；没看到的关联行不删除也不更新时间，asinCount 按行数重算', async () => {
    const db = setup()
    await db.run()
    const draft = byKey(db, 'KEY-DRAFT')
    const old = new Date('2026-01-01T00:00:00Z')
    db.relations.rows.push({ id: 'x1', tenantId: 't1', contentId: draft.id, asin: 'B0ZZZZZZZZ', publishedAt: null, lastSeenAt: old })
    const approvedRelation = db.relations.rows.find(row => row.contentId === byKey(db, 'KEY-APPROVED').id)!
    const later = new Date('2026-10-26T00:00:00Z')
    const result = await db.run({ now: later })
    expect(result).toMatchObject({ created: 0, updated: 3, events: 0 })
    expect(db.events.rows).toHaveLength(3)
    expect(db.relations.rows.find(row => row.id === 'x1')).toMatchObject({ lastSeenAt: old })
    expect(draft.asinCount).toBe(4)
    expect(approvedRelation).toMatchObject({ lastSeenAt: later, publishedAt: new Date('2026-10-19T00:00:00Z') })
    expect(db.contents.rows).toHaveLength(3)
  })

  it('状态变化写一条新事件；亚马逊侧已经没有的内容保持原样不删除', async () => {
    const db = setup()
    db.seedContent({ contentReferenceKey: 'KEY-DRAFT', status: 'SUBMITTED', name: 'Summer launch', version: 7 })
    db.seedContent({ contentReferenceKey: 'KEY-GONE', status: 'APPROVED', name: 'Gone on Amazon' })
    await db.run()
    expect(byKey(db, 'KEY-DRAFT')).toMatchObject({ status: 'DRAFT', version: 7 }) // version 只在接口受理写入时加 1，同步不碰
    expect(db.events.rows.filter(row => row.contentId === byKey(db, 'KEY-DRAFT').id).map(row => row.status)).toEqual(['DRAFT'])
    expect(byKey(db, 'KEY-GONE')).toMatchObject({ status: 'APPROVED', name: 'Gone on Amazon' })
    expect(db.events.rows.some(row => row.contentId === byKey(db, 'KEY-GONE').id)).toBe(false)
  })

  it('被拒后重新变回别的状态：拒绝原文清空；状态不变时不写事件', async () => {
    const db = setup()
    db.seedContent({ contentReferenceKey: 'KEY-DRAFT', status: 'REJECTED', rejectionReason: 'old text' })
    await db.run()
    expect(byKey(db, 'KEY-DRAFT')).toMatchObject({ status: 'DRAFT', rejectionReason: null })
  })
})

describe('不覆盖本地的修改', () => {
  it('这份内容有排队中或处理中的写入：整份跳过，本地名称、模块、事件都不动', async () => {
    const db = setup()
    const local = db.seedContent({ contentReferenceKey: 'KEY-DRAFT', name: 'Local edit', draftJson: { contentModuleList: ['mine'] } })
    db.runs.rows.push({ id: 'run1', tenantId: 't1', sellerAccountId: 'sa1', contentId: local.id, kind: 'UPDATE', status: 'RUNNING' })
    const result = await db.run()
    expect(result).toMatchObject({ skippedBusy: 1, created: 2 })
    expect(local).toMatchObject({ name: 'Local edit', draftJson: { contentModuleList: ['mine'] }, status: 'DRAFT' })
    expect(db.events.rows.some(row => row.contentId === local.id)).toBe(false)
    expect(db.logger.warn).toHaveBeenCalled()
  })

  it('已经完成的写入不挡同步；店铺有创建任务在途时本轮不新建本地行，已有的照常更新', async () => {
    const db = setup()
    const local = db.seedContent({ contentReferenceKey: 'KEY-DRAFT', name: 'Old name' })
    db.runs.rows.push({ id: 'run1', tenantId: 't1', sellerAccountId: 'sa1', contentId: local.id, kind: 'UPDATE', status: 'SUCCEEDED' })
    db.runs.rows.push({ id: 'run2', tenantId: 't1', sellerAccountId: 'sa1', contentId: null, kind: 'CREATE', status: 'QUEUED' })
    const result = await db.run()
    expect(result).toMatchObject({ updated: 1, created: 0, skippedBusy: 2 })
    expect(local.name).toBe('Summer launch')
    expect(db.contents.rows).toHaveLength(1)
  })
})

describe('状态不认识', () => {
  const weird = {
    getContent: async (key: string) => ({ contentRecord: { contentReferenceKey: key, contentMetadata: { name: 'N', status: 'IN_REVIEW_BY_ALIEN' }, contentDocument: { contentModuleList: [] } } }),
  }
  it('已有内容保持原状态；新内容不写（不拿“草稿”顶替）', async () => {
    const db = setup(weird)
    db.seedContent({ contentReferenceKey: 'KEY-APPROVED', status: 'SUBMITTED', rejectionReason: 'kept' })
    const result = await db.run()
    expect(byKey(db, 'KEY-APPROVED')).toMatchObject({ status: 'SUBMITTED', rejectionReason: 'kept' })
    expect(result).toMatchObject({ updated: 1, created: 0, skippedInvalid: 2 })
  })
})

describe('发布记录', () => {
  it('每次最多查 N 个 ASIN；上线时间为空的优先，已有上线时间的排在后面', async () => {
    const db = setup({ listContents: async () => ({ contentMetadataRecords: [{ contentReferenceKey: 'KEY-APPROVED' }] }) })
    const content = db.seedContent({ contentReferenceKey: 'KEY-APPROVED', status: 'APPROVED', name: 'Brand story' })
    const asinsOf = ['B0AAAAAAA1', 'B0AAAAAAA2', 'B0AAAAAAA3']
    asinsOf.forEach((asin, index) =>
      db.relations.rows.push({ id: `p${index}`, tenantId: 't1', contentId: content.id, asin, publishedAt: index === 0 ? new Date('2026-10-01T00:00:00Z') : null, lastSeenAt: NOW }),
    )
    const result = await db.run({ publishAsinsMax: 2 })
    expect(result).toMatchObject({ publishAsinsChecked: 2 })
    expect(db.api.listPublishRecords.mock.calls.map(call => call[0]).sort()).toEqual(['B0AAAAAAA2', 'B0AAAAAAA3'])
    // 没查到的那个 ASIN 保留已有的上线时间；内容的上线时间取所有行里最早的
    expect(content).toMatchObject({ status: 'PUBLISHED', publishedAt: new Date('2026-10-01T00:00:00Z') })
    expect(db.relations.rows.find(row => row.asin === 'B0AAAAAAA2')?.publishedAt).toEqual(new Date('2026-10-19T00:00:00Z'))
  })

  it('记录里没有本内容的上线时间（没有时间，或只有别的内容的记录）：已批准内容保持已批准，不写上线时间', async () => {
    for (const body of [
      { contentPublishRecordList: [{ contentReferenceKey: 'KEY-APPROVED', contentStatus: 'APPROVED' }] },
      { contentPublishRecordList: [{ contentReferenceKey: 'KEY-OTHER', publishTime: '2026-09-01T00:00:00Z' }] },
    ]) {
      const db = setup({ listPublishRecords: async () => body })
      await db.run()
      expect(byKey(db, 'KEY-APPROVED')).toMatchObject({ status: 'APPROVED' })
      expect(byKey(db, 'KEY-APPROVED').publishedAt).toBeUndefined()
      expect(db.relations.rows.some(row => row.publishedAt)).toBe(false)
    }
  })

  it('最早上线时间：一个 ASIN 的记录比另一个早时取更早的', async () => {
    const db = setup({
      listContents: async () => ({ contentMetadataRecords: [{ contentReferenceKey: 'KEY-APPROVED' }] }),
      listAsins: async () => ({ asinMetadataSet: [{ asin: 'B0AAAAAAA1' }, { asin: 'B0AAAAAAA2' }] }),
      listPublishRecords: async (asin: string) => ({
        contentPublishRecordList: [{ contentReferenceKey: 'KEY-APPROVED', publishTime: asin === 'B0AAAAAAA1' ? '2026-10-10T00:00:00Z' : '2026-10-05T00:00:00Z' }],
      }),
    })
    await db.run()
    expect(byKey(db, 'KEY-APPROVED').publishedAt).toEqual(new Date('2026-10-05T00:00:00Z'))
  })

  it('某个 ASIN 的发布记录 404：跳过它，其余照常；429 向上抛', async () => {
    const skipping = setup({
      listPublishRecords: async (asin: string) => {
        if (asin === 'B0AAAAAAA1') throw upstream(404)
        return fixture('publish-records.json')
      },
    })
    const result = await skipping.run()
    expect(result.publishAsinsChecked).toBe(2)
    expect(byKey(skipping, 'KEY-APPROVED').status).toBe('PUBLISHED')
    const throttled = setup({
      listPublishRecords: async () => {
        throw upstream(429)
      },
    })
    await expect(throttled.run()).rejects.toMatchObject({ status: 429 })
  })
})

describe('上限与单份失败', () => {
  it('内容超过上限：只同步前面的，记日志，不报错', async () => {
    const db = setup()
    const result = await db.run({ contentsMax: 1 })
    expect(result).toMatchObject({ imported: 1, truncated: true })
    expect(db.contents.rows).toHaveLength(1)
    expect(db.logger.warn).toHaveBeenCalled()
  })

  it('单份详情 404：跳过并计数；429 与 5xx 向上抛让任务重试', async () => {
    const missing = setup({
      getContent: async (key: string) => {
        if (key === 'KEY-APPROVED') throw upstream(404)
        return fixture(DETAILS[key])
      },
    })
    expect(await missing.run()).toMatchObject({ imported: 2, skippedInvalid: 1 })
    for (const status of [429, 503]) {
      const failing = setup({
        getContent: async () => {
          throw upstream(status)
        },
      })
      await expect(failing.run()).rejects.toMatchObject({ status })
    }
  })

  it('响应形状认不出：抛 APL_RESPONSE_UNRECOGNIZED，一行都不写', async () => {
    const db = setup({ listContents: async () => ({ unexpected: true }) })
    await expect(db.run()).rejects.toMatchObject({ code: 'APL_RESPONSE_UNRECOGNIZED' })
    expect(db.contents.rows).toHaveLength(0)
  })
})

describe('没有 A+ 内容角色', () => {
  it('403：以不可重试的 APL_ROLE_MISSING 结束，一行都不写', async () => {
    const db = setup()
    const client = {
      request: vi.fn(async () => {
        throw upstream(403)
      }),
    }
    const failure = syncAplus({ prisma: db.prisma, logger: db.logger }, new AplusApi(client as never), scope, { now: NOW })
    await expect(failure).rejects.toBeInstanceOf(NonRetryableError)
    await expect(failure).rejects.toMatchObject({ code: 'APL_ROLE_MISSING' })
    expect(db.contents.rows).toHaveLength(0)
  })
})
