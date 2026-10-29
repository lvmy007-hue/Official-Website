import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 外部货号映射、装箱单列映射与装箱单匹配接口的权限与参数校验（内存替身）；规则与真实数据行为见 testing/packing-list.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('外部货号映射接口：权限', () => {
  it('没有 inbound.read：列表、导出、列映射读取 403；有 inbound.read 但没有 skualias.manage：新增、修改、删除、导入、保存列映射都是 403', async () => {
    harness = await createTestApp(sessionStub([]))
    for (const path of ['/sku-aliases', '/sku-aliases/export', '/packing-list-mappings', '/packing-list-mappings/s1']) expect((await harness.call('GET', path)).status, path).toBe(403)
    await harness.close()
    harness = await createTestApp(sessionStub(['inbound.read', 'inbound.plan.write']))
    expect((await harness.call('POST', '/sku-aliases', { body: { externalCode: 'A', sku: 'S' } })).status).toBe(403)
    expect((await harness.call('PUT', '/sku-aliases/a1', { body: { version: 1, sku: 'S' } })).status).toBe(403)
    expect((await harness.call('DELETE', '/sku-aliases/a1')).status).toBe(403)
    expect((await harness.call('POST', '/sku-aliases/import', { body: { fileName: 'a.csv', content: '外部货号,SKU\nA,S' } })).status).toBe(403)
    expect((await harness.call('PUT', '/packing-list-mappings/s1', { body: { columns: { code: '货号' } } })).status).toBe(403)
    expect((await harness.call('DELETE', '/packing-list-mappings/s1')).status).toBe(403)
  })

  it('装箱单预览与应用要 inbound.plan.write（只读成员 403，且先于参数校验）', async () => {
    harness = await createTestApp(sessionStub(['inbound.read']))
    expect((await harness.call('POST', '/inbound/plans/p1/packing-list/parse', { body: {} })).status).toBe(403)
    expect((await harness.call('POST', '/inbound/plans/p1/packing-list/apply', { body: {} })).status).toBe(403)
  })
})

describe('外部货号映射接口：参数校验', () => {
  it('新增：缺字段、多余字段、过长都是 422 并指出字段', async () => {
    harness = await createTestApp(sessionStub(['skualias.manage']))
    const missing = await harness.call('POST', '/sku-aliases', { body: {} })
    expect(missing.status).toBe(422)
    expect(Object.keys(missing.json.error.fieldErrors ?? {})).toEqual(expect.arrayContaining(['externalCode', 'sku']))
    expect((await harness.call('POST', '/sku-aliases', { body: { externalCode: 'A', sku: 'S', tenantId: 'x' } })).status).toBe(422)
    expect((await harness.call('POST', '/sku-aliases', { body: { externalCode: 'x'.repeat(121), sku: 'S' } })).status).toBe(422)
  })

  it('修改：必须带版本号且至少改一项，供应商不能改；列表筛选取值不合格 422；导入内容为空 422', async () => {
    harness = await createTestApp(sessionStub(['skualias.manage', 'inbound.read']))
    expect((await harness.call('PUT', '/sku-aliases/a1', { body: { sku: 'S' } })).status).toBe(422)
    expect((await harness.call('PUT', '/sku-aliases/a1', { body: { version: 1 } })).status).toBe(422)
    expect((await harness.call('PUT', '/sku-aliases/a1', { body: { version: 1, supplierId: 's2' } })).status).toBe(422)
    expect((await harness.call('GET', '/sku-aliases?source=BAD')).status).toBe(422)
    expect((await harness.call('GET', '/sku-aliases?sort=bad')).status).toBe(422)
    expect((await harness.call('POST', '/sku-aliases/import', { body: { fileName: 'a.csv', content: '' } })).status).toBe(422)
  })

  it('列映射：至少映射一列，列名不认识 422，版本号要是正整数', async () => {
    harness = await createTestApp(sessionStub(['skualias.manage']))
    expect((await harness.call('PUT', '/packing-list-mappings/s1', { body: { columns: {} } })).status).toBe(422)
    expect((await harness.call('PUT', '/packing-list-mappings/s1', { body: { columns: { bogus: 'x' } } })).status).toBe(422)
    expect((await harness.call('PUT', '/packing-list-mappings/s1', { body: { columns: { code: '货号' }, version: 0 } })).status).toBe(422)
    expect((await harness.call('PUT', '/packing-list-mappings/s1', { body: { columns: { code: '货号' }, units: { length: 'FT' } } })).status).toBe(422)
  })

  it('装箱单预览与应用：文件类型、内容、决定的格式不对都是 422', async () => {
    harness = await createTestApp(sessionStub(['inbound.plan.write']))
    const file = { fileName: 'p.csv', format: 'CSV', content: '货号,数量\nA,1' }
    expect((await harness.call('POST', '/inbound/plans/p1/packing-list/parse', { body: { ...file, format: 'PDF' } })).status).toBe(422)
    expect((await harness.call('POST', '/inbound/plans/p1/packing-list/parse', { body: { ...file, content: '' } })).status).toBe(422)
    expect((await harness.call('POST', '/inbound/plans/p1/packing-list/parse', { body: { ...file, headerLine: 99 } })).status).toBe(422)
    expect((await harness.call('POST', '/inbound/plans/p1/packing-list/parse', { body: { ...file, columns: { code: 999 } } })).status).toBe(422)
    expect((await harness.call('POST', '/inbound/plans/p1/packing-list/parse', { body: { ...file, extra: 1 } })).status).toBe(422)
    expect((await harness.call('POST', '/inbound/plans/p1/packing-list/apply', { body: { ...file, decisions: [] } })).status).toBe(422)
    const dup = await harness.call('POST', '/inbound/plans/p1/packing-list/apply', { body: { ...file, version: 1, decisions: [{ line: 2 }, { line: 2 }] } })
    expect(dup.status).toBe(422)
  })
})
