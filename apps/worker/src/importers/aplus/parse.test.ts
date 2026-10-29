import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dateOf, parseAsinList, parseContentDetail, parseContentList, parsePublishRecords, parseUploadDestination, parseWriteAck } from './parse'

// A+ 响应解析（P4-14）：接口形状没有用真实店铺核对，所以重点验证“宽容”——缺字段当没有、payload 外层可有可无、认不出整体形状才抛 APL_RESPONSE_UNRECOGNIZED，
// 以及不编造：没有被拒原文就是 null，没有上线时间就是 null，没有模块列表就是 null（不是空数组）。

const FIXTURES = join(__dirname, '../../../fixtures/aplus')
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const unrecognized = { code: 'APL_RESPONSE_UNRECOGNIZED' }

describe('内容列表', () => {
  it('取引用键、名称、状态原文、更新时间与下一页令牌；缺引用键的跳过并计数', () => {
    const parsed = parseContentList(fixture('list-page1.json'))
    expect(parsed.items.map(item => item.key)).toEqual(['KEY-DRAFT', 'KEY-APPROVED'])
    expect(parsed.items[0]).toMatchObject({ name: 'Summer launch', status: 'DRAFT', updatedAt: new Date('2026-10-20T08:00:00Z') })
    expect(parsed).toMatchObject({ nextToken: 'page-2', skipped: 1 })
  })

  it('缺字段当没有；没有下一页令牌为 null；空对象与空数组都是没有内容', () => {
    expect(parseContentList({ contentMetadataRecords: [{ contentReferenceKey: 'K1' }] }).items).toEqual([{ key: 'K1', name: null, status: null, updatedAt: null }])
    expect(parseContentList({})).toEqual({ items: [], nextToken: null, skipped: 0 })
    expect(parseContentList({ contentMetadataRecords: [] }).items).toEqual([])
  })

  it('带 payload 外层也认', () => {
    expect(parseContentList({ payload: fixture('list-page2.json') }).items.map(item => item.key)).toEqual(['KEY-REJECTED'])
  })

  it('形状认不出来：抛 APL_RESPONSE_UNRECOGNIZED（不是对象、有内容但没有已知字段、关键字段类型不对）', () => {
    for (const body of [null, 'oops', [1], { foo: 1 }, { contentMetadataRecords: 'x' }]) expect(() => parseContentList(body)).toThrowError(expect.objectContaining(unrecognized))
  })
})

describe('内容详情', () => {
  it('取名称、类型、语言、状态、更新时间与模块（原样保留）', () => {
    const raw = fixture('detail-draft.json') as { contentRecord: { contentDocument: { contentModuleList: unknown[] } } }
    const parsed = parseContentDetail(raw)
    expect(parsed).toMatchObject({ key: 'KEY-DRAFT', name: 'Summer launch', contentType: 'EBC', locale: 'en-US', status: 'DRAFT', rejectionReason: null })
    expect(parsed.modules).toEqual(raw.contentRecord.contentDocument.contentModuleList)
    expect(parsed.updatedAt).toEqual(new Date('2026-10-20T08:00:00Z'))
  })

  it('被拒原文：取到就是原文，取不到是 null；原文也可以是带 message 的对象', () => {
    expect(parseContentDetail(fixture('detail-rejected.json')).rejectionReason).toBe('Image contains price information (see guidelines).')
    expect(parseContentDetail({ contentRecord: { contentMetadata: { status: 'REJECTED', reason: { message: 'bad text' } } } }).rejectionReason).toBe('bad text')
    expect(parseContentDetail({ contentRecord: { contentMetadata: { status: 'REJECTED' } } }).rejectionReason).toBeNull()
  })

  it('没有 contentDocument 或没有模块列表：modules 是 null（不能用空数组顶替）；空列表则是空数组；不认识的类型当没有', () => {
    expect(parseContentDetail({ contentRecord: { contentReferenceKey: 'K' } }).modules).toBeNull()
    expect(parseContentDetail({ contentRecord: { contentDocument: { name: 'x' } } }).modules).toBeNull()
    expect(parseContentDetail(fixture('detail-rejected.json')).modules).toEqual([])
    expect(parseContentDetail({ contentRecord: { contentDocument: { contentType: 'WEIRD' } } }).contentType).toBeNull()
    expect(parseContentDetail({ contentRecord: { contentDocument: { contentType: 'emc' } } }).contentType).toBe('EMC')
  })

  it('认不出：没有 contentRecord（含空响应）抛 APL_RESPONSE_UNRECOGNIZED', () => {
    for (const body of [null, {}, { foo: 1 }, { contentRecord: 'x' }]) expect(() => parseContentDetail(body)).toThrowError(expect.objectContaining(unrecognized))
  })
})

describe('关联 ASIN', () => {
  it('ASIN 转大写、去重；格式不对的跳过并计数；也认纯字符串条目', () => {
    expect(parseAsinList(fixture('asins.json'))).toEqual({ asins: ['B0AAAAAAA1', 'B0AAAAAAA2', 'B0AAAAAAA3'], nextToken: null, skipped: 1 })
    expect(parseAsinList({ asinMetadataSet: [{ asin: 'B0AAAAAAA1' }, { asin: 'b0aaaaaaa1' }], nextPageToken: 'n' })).toMatchObject({ asins: ['B0AAAAAAA1'], nextToken: 'n' })
    expect(parseAsinList({}).asins).toEqual([])
  })

  it('形状认不出：抛 APL_RESPONSE_UNRECOGNIZED', () => {
    for (const body of ['x', { asinMetadataSet: {} }, { foo: 1 }]) expect(() => parseAsinList(body)).toThrowError(expect.objectContaining(unrecognized))
  })
})

describe('发布记录', () => {
  it('上线时间按候选字段名宽容地取；没有或认不出就是 null，不拿别的时间顶替', () => {
    const parsed = parsePublishRecords(fixture('publish-records.json'))
    expect(parsed.records.map(item => [item.key, item.publishedAt?.toISOString() ?? null])).toEqual([
      ['KEY-APPROVED', '2026-10-19T00:00:00.000Z'],
      ['KEY-OTHER', '2026-09-01T00:00:00.000Z'],
      ['KEY-NOTIME', null],
    ])
    const odd = parsePublishRecords({
      contentPublishRecordList: [{ contentReferenceKey: 'K', publishTime: 'not a date', liveTime: '2026-10-01T00:00:00Z' }, { contentReferenceKey: 'K2', publishTime: 12345 }, { foo: 1 }],
    })
    expect(odd.records.map(item => item.publishedAt?.toISOString() ?? null)).toEqual(['2026-10-01T00:00:00.000Z', null])
    expect(odd.skipped).toBe(1)
  })

  it('形状认不出：抛 APL_RESPONSE_UNRECOGNIZED', () => {
    expect(() => parsePublishRecords({ contentPublishRecordList: 'x' })).toThrowError(expect.objectContaining(unrecognized))
    expect(() => parsePublishRecords(42)).toThrowError(expect.objectContaining(unrecognized))
  })
})

describe('写入响应', () => {
  it('创建必须带回引用键；警告对象取 message，没有 message 取 code，也认纯字符串', () => {
    expect(parseWriteAck({ contentReferenceKey: 'K1', warnings: [{ code: 'W1', message: 'Check image' }, { code: 'W2' }, 'plain', {}] }, true)).toEqual({
      contentReferenceKey: 'K1',
      warnings: ['Check image', 'W2', 'plain'],
    })
    expect(parseWriteAck({ payload: { contentReferenceKey: 'K2' } }, true).contentReferenceKey).toBe('K2')
    expect(() => parseWriteAck({ warnings: [] }, true)).toThrowError(expect.objectContaining(unrecognized))
    expect(() => parseWriteAck(null, true)).toThrowError(expect.objectContaining(unrecognized))
  })

  it('其余操作：没有响应体也算受理（2xx 即受理）；不是对象认不出', () => {
    expect(parseWriteAck(null)).toEqual({ contentReferenceKey: null, warnings: [] })
    expect(parseWriteAck({ warnings: [{ message: 'm' }] }).warnings).toEqual(['m'])
    expect(() => parseWriteAck('ok')).toThrowError(expect.objectContaining(unrecognized))
    expect(() => parseWriteAck([])).toThrowError(expect.objectContaining(unrecognized))
  })

  it('警告最多 50 条、每条最多 500 个字符', () => {
    const warnings = Array.from({ length: 60 }, () => 'x'.repeat(600))
    const parsed = parseWriteAck({ warnings })
    expect(parsed.warnings).toHaveLength(50)
    expect(parsed.warnings[0]).toHaveLength(500)
  })
})

describe('上传目的地', () => {
  it('有 payload 外层与没有外层两种都认；请求头只留字符串与数字', () => {
    const wrapped = parseUploadDestination(fixture('upload-destination.json'))
    expect(wrapped).toEqual({ uploadDestinationId: 'sc/e1f2a3.png', url: 'https://s3.example.invalid/upload/e1f2a3', headers: { 'Content-MD5': 'abc==', 'x-amz-acl': 'private' } })
    expect(parseUploadDestination({ uploadDestinationId: 'u', url: 'https://x/y', headers: { a: 1, b: { c: 1 } } })).toEqual({ uploadDestinationId: 'u', url: 'https://x/y', headers: { a: '1' } })
  })

  it('缺编号、缺地址或地址不是 https：抛 APL_RESPONSE_UNRECOGNIZED', () => {
    for (const body of [null, {}, { payload: { url: 'https://x' } }, { uploadDestinationId: 'u' }, { uploadDestinationId: 'u', url: 'http://x' }])
      expect(() => parseUploadDestination(body)).toThrowError(expect.objectContaining(unrecognized))
  })
})

describe('时间', () => {
  it('只认能解析且年份合理的日期字符串', () => {
    expect(dateOf('2026-10-20T08:00:00Z')).toEqual(new Date('2026-10-20T08:00:00Z'))
    for (const value of [null, '', 'x', 1_700_000_000, '1970-01-01T00:00:00Z', '2999-01-01']) expect(dateOf(value)).toBeNull()
  })
})
