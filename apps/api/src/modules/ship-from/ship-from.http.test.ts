import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 发货地址接口的权限与参数校验（内存替身）；规则与真实数据行为见 testing/ship-from.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const body = { sellerAccountId: 's1', name: '洛杉矶仓', addressLine1: '1 Main St', city: 'Los Angeles', stateOrProvince: 'CA', postalCode: '90001', countryCode: 'US', phone: '3105550100' }

describe('发货地址接口：权限', () => {
  it('没有 inbound.read：列表 403；有 inbound.read 但没有 shipfrom.manage：新增、修改、设默认、删除都是 403', async () => {
    harness = await createTestApp(sessionStub([]))
    expect((await harness.call('GET', '/ship-from-addresses')).status).toBe(403)
    await harness.close()
    harness = await createTestApp(sessionStub(['inbound.read', 'inbound.plan.write']))
    expect((await harness.call('POST', '/ship-from-addresses', { body })).status).toBe(403)
    expect((await harness.call('PUT', '/ship-from-addresses/a1', { body: { version: 1, city: 'x' } })).status).toBe(403)
    expect((await harness.call('POST', '/ship-from-addresses/a1/default')).status).toBe(403)
    expect((await harness.call('DELETE', '/ship-from-addresses/a1')).status).toBe(403)
  })
})

describe('发货地址接口：参数校验', () => {
  it('新增：缺字段、国家代码不是两位字母、多余字段都是 422，并指出字段', async () => {
    harness = await createTestApp(sessionStub(['shipfrom.manage']))
    const missing = await harness.call('POST', '/ship-from-addresses', { body: { sellerAccountId: 's1' } })
    expect(missing.status).toBe(422)
    expect(Object.keys(missing.json.error.fieldErrors ?? {})).toEqual(expect.arrayContaining(['name', 'addressLine1', 'phone']))
    expect((await harness.call('POST', '/ship-from-addresses', { body: { ...body, countryCode: 'USA' } })).status).toBe(422)
    expect((await harness.call('POST', '/ship-from-addresses', { body: { ...body, isAdmin: true } })).status).toBe(422)
  })

  it('修改：必须带版本号且至少改一项；店铺不能改；列表状态筛选取值不合格 422', async () => {
    harness = await createTestApp(sessionStub(['shipfrom.manage', 'inbound.read']))
    expect((await harness.call('PUT', '/ship-from-addresses/a1', { body: { city: 'x' } })).status).toBe(422)
    expect((await harness.call('PUT', '/ship-from-addresses/a1', { body: { version: 1 } })).status).toBe(422)
    expect((await harness.call('PUT', '/ship-from-addresses/a1', { body: { version: 1, sellerAccountId: 's2' } })).status).toBe(422)
    expect((await harness.call('GET', '/ship-from-addresses?status=BAD')).status).toBe(422)
  })
})
