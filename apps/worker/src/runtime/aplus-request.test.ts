import { describe, expect, it } from 'vitest'
import { parseAplusRequest } from './aplus-request'

// A+ 写入记录里的请求内容（P4-14）：严格按约定的形状读，缺字段、类型不对一律是不可重试的 APL_REQUEST_INVALID。
const invalid = { code: 'APL_REQUEST_INVALID' }

describe('按类型读取请求内容', () => {
  it('创建：名称、类型（EBC 或 EMC）、语言与模块列表', () => {
    expect(parseAplusRequest('CREATE', { name: ' Summer ', contentType: 'EMC', locale: 'en-US', contentModuleList: [{ a: 1 }] })).toEqual({
      kind: 'CREATE',
      name: 'Summer',
      contentType: 'EMC',
      locale: 'en-US',
      contentModuleList: [{ a: 1 }],
    })
    for (const bad of [
      {},
      { name: 'N', contentType: 'XYZ', locale: 'en-US', contentModuleList: [] },
      { name: 'N', contentType: 'EBC', contentModuleList: [] },
      { name: 'N', contentType: 'EBC', locale: 'en-US' },
      { name: '  ', contentType: 'EBC', locale: 'en-US', contentModuleList: [] },
    ]) {
      expect(() => parseAplusRequest('CREATE', bad)).toThrowError(expect.objectContaining(invalid))
    }
  })

  it('保存修改：名称与完整模块列表（空列表也是列表）', () => {
    expect(parseAplusRequest('UPDATE', { name: 'N', contentModuleList: [] })).toEqual({ kind: 'UPDATE', name: 'N', contentModuleList: [] })
    for (const bad of [{ name: 'N' }, { contentModuleList: [] }, { name: 'N', contentModuleList: 'x' }]) expect(() => parseAplusRequest('UPDATE', bad)).toThrowError(expect.objectContaining(invalid))
  })

  it('关联 ASIN：转大写、去重；空、格式不对一律不完整', () => {
    expect(parseAplusRequest('ASSOCIATE', { asins: ['b0aaaaaaa1', 'B0AAAAAAA1', 'B0AAAAAAA2'] })).toEqual({ kind: 'ASSOCIATE', asins: ['B0AAAAAAA1', 'B0AAAAAAA2'] })
    for (const bad of [{}, { asins: [] }, { asins: ['short'] }, { asins: ['B0AAAAAAA1', 5] }, { asins: 'B0AAAAAAA1' }])
      expect(() => parseAplusRequest('ASSOCIATE', bad)).toThrowError(expect.objectContaining(invalid))
  })

  it('提交审核：空对象就行，请求内容为 null 或不是对象也一样', () => {
    for (const body of [{}, null, 'x', []]) expect(parseAplusRequest('SUBMIT', body)).toEqual({ kind: 'SUBMIT' })
  })

  it('上传图片：需要文件路径与图片类型（JPEG 或 PNG），文件名可没有', () => {
    expect(parseAplusRequest('UPLOAD', { storeId: 's', objectKey: 'tenants/t1/a.png', fileName: 'a.png', contentType: 'image/png', sizeBytes: 5, width: 10, height: 10 })).toEqual({
      kind: 'UPLOAD',
      objectKey: 'tenants/t1/a.png',
      contentType: 'image/png',
      fileName: 'a.png',
    })
    expect(parseAplusRequest('UPLOAD', { objectKey: 'k', contentType: 'image/jpeg' })).toMatchObject({ fileName: null })
    for (const bad of [{}, { objectKey: 'k' }, { objectKey: 'k', contentType: 'image/gif' }, { contentType: 'image/png' }])
      expect(() => parseAplusRequest('UPLOAD', bad)).toThrowError(expect.objectContaining(invalid))
  })

  it('不认识的类型：不完整', () => {
    expect(() => parseAplusRequest('DELETE', {})).toThrowError(expect.objectContaining(invalid))
  })
})
