import { DEFAULT_BOX_NO_RULE, DEFAULT_LABEL_OPTIONS } from '@nova/api-contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 标签模板与标签生成接口的权限与参数校验（内存替身）；规则与真实数据行为见 testing/label-template.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const body = { name: '4×6 热敏', paper: 'THERMAL_4X6', options: DEFAULT_LABEL_OPTIONS, boxNoRule: DEFAULT_BOX_NO_RULE, isDefault: false }

describe('标签模板接口：权限', () => {
  it('没有 inbound.read：列表 403；有 inbound.read 但没有 labeltemplate.manage：新增、修改、删除都是 403', async () => {
    harness = await createTestApp(sessionStub([]))
    expect((await harness.call('GET', '/label-templates')).status).toBe(403)
    await harness.close()
    harness = await createTestApp(sessionStub(['inbound.read', 'inbound.plan.write']))
    expect((await harness.call('POST', '/label-templates', { body })).status).toBe(403)
    expect((await harness.call('PUT', '/label-templates/t1', { body: { ...body, version: 1 } })).status).toBe(403)
    expect((await harness.call('DELETE', '/label-templates/t1')).status).toBe(403)
  })

  it('生成自定义箱标签与商品标签：没有 inbound.plan.write 是 403；有写权限但没有导出权限也是 403，参数校验在权限之后', async () => {
    harness = await createTestApp(sessionStub(['inbound.read']))
    expect((await harness.call('POST', '/inbound/shipments/s1/labels/custom', { body: {} })).status).toBe(403)
    expect((await harness.call('POST', '/inbound/plans/p1/item-labels', { body: { size: 'THERMAL_60X40' } })).status).toBe(403)
    await harness.close()
    harness = await createTestApp(sessionStub(['inbound.read', 'inbound.plan.write']))
    expect((await harness.call('POST', '/inbound/shipments/s1/labels/custom', { body: {} })).status).toBe(403)
    expect((await harness.call('POST', '/inbound/plans/p1/item-labels', { body: { size: 'THERMAL_60X40' } })).status).toBe(403)
  })
})

describe('标签模板接口：参数校验', () => {
  it('新增：缺字段、纸张不认识、多余字段都是 422，并指出字段', async () => {
    harness = await createTestApp(sessionStub(['labeltemplate.manage']))
    const missing = await harness.call('POST', '/label-templates', { body: { name: '' } })
    expect(missing.status).toBe(422)
    expect(Object.keys(missing.json.error.fieldErrors ?? {})).toEqual(expect.arrayContaining(['name', 'paper', 'options', 'boxNoRule']))
    expect((await harness.call('POST', '/label-templates', { body: { ...body, paper: 'LETTER' } })).status).toBe(422)
    expect((await harness.call('POST', '/label-templates', { body: { ...body, isAdmin: true } })).status).toBe(422)
    expect((await harness.call('POST', '/label-templates', { body: { ...body, options: { ...DEFAULT_LABEL_OPTIONS, extra: 1 } } })).status).toBe(422)
  })

  it('组合校验：A4 拼版不能追加到原标签、也不能按我方箱号重排；箱号规则只允许字母数字与 _ . # / -；勾选原产地必须填文字', async () => {
    harness = await createTestApp(sessionStub(['labeltemplate.manage']))
    const append = await harness.call('POST', '/label-templates', { body: { ...body, paper: 'A4_4UP', options: { ...DEFAULT_LABEL_OPTIONS, appendToOriginal: true } } })
    expect(append.status).toBe(422)
    expect(append.json.error.fieldErrors?.options?.join('')).toContain('不能追加到原标签')
    const order = await harness.call('POST', '/label-templates', { body: { ...body, paper: 'A4_2UP', options: { ...DEFAULT_LABEL_OPTIONS, order: 'OURS' } } })
    expect(order.json.error.fieldErrors?.options?.join('')).toContain('不能按我方箱号重新排序')
    const chars = await harness.call('POST', '/label-templates', { body: { ...body, boxNoRule: { ...DEFAULT_BOX_NO_RULE, prefix: '箱 1' } } })
    expect(chars.json.error.fieldErrors?.boxNoRule?.join('')).toContain('前缀只能用字母、数字')
    const origin = await harness.call('POST', '/label-templates', { body: { ...body, options: { ...DEFAULT_LABEL_OPTIONS, showOrigin: true, originText: '  ' } } })
    expect(origin.json.error.fieldErrors?.options?.join('')).toContain('请填写原产地文字')
  })

  it('修改：必须带版本号并整份给出；列表排序字段不认识 422', async () => {
    harness = await createTestApp(sessionStub(['labeltemplate.manage', 'inbound.read']))
    expect((await harness.call('PUT', '/label-templates/t1', { body })).status).toBe(422)
    expect((await harness.call('PUT', '/label-templates/t1', { body: { version: 1, name: 'x' } })).status).toBe(422)
    expect((await harness.call('GET', '/label-templates?sort=bad')).status).toBe(422)
  })

  it('生成自定义箱标签与商品标签：权限齐全后，起始序号、纸张规格不合格 422', async () => {
    harness = await createTestApp(sessionStub(['inbound.read', 'inbound.plan.write', 'export.create']))
    expect((await harness.call('POST', '/inbound/shipments/s1/labels/custom', { body: { startNumber: -1 } })).status).toBe(422)
    expect((await harness.call('POST', '/inbound/shipments/s1/labels/custom', { body: { foo: 1 } })).status).toBe(422)
    expect((await harness.call('POST', '/inbound/plans/p1/item-labels', { body: { size: 'A5' } })).status).toBe(422)
    expect((await harness.call('POST', '/inbound/plans/p1/item-labels', { body: {} })).status).toBe(422)
  })
})
