import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 补货批次转入仓计划草稿接口的权限与参数校验（内存替身）；分组、地址、转过判断、并发与追溯见 testing/batch-inbound.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const PATH = '/replenishment/batches/b1/to-inbound-drafts'
const item = { recommendationId: 'r1' }

describe('补货转入仓计划草稿：权限', () => {
  it('缺 replenishment.plan.create 或缺 inbound.plan.write 都是 403（预览与确认一样）；意向清单要 replenishment.read', async () => {
    harness = await createTestApp(sessionStub(['inbound.plan.write', 'replenishment.read']))
    expect((await harness.call('POST', PATH, { body: { items: [item] } })).status).toBe(403)
    await harness.close()
    harness = await createTestApp(sessionStub(['replenishment.plan.create', 'replenishment.read']))
    expect((await harness.call('POST', PATH, { body: { items: [item], dryRun: false } })).status).toBe(403)
    await harness.close()
    harness = await createTestApp(sessionStub([]))
    expect((await harness.call('GET', '/replenishment/intents')).status).toBe(403)
  })
})

describe('补货转入仓计划草稿：参数校验', () => {
  it('没勾选、重复勾选、数量小于 1、dryRun 不是布尔值、多余字段都是 422', async () => {
    harness = await createTestApp(sessionStub(['replenishment.plan.create', 'inbound.plan.write']))
    expect((await harness.call('POST', PATH, { body: { items: [] } })).status).toBe(422)
    expect((await harness.call('POST', PATH, { body: { items: [item, item] } })).status).toBe(422)
    expect((await harness.call('POST', PATH, { body: { items: [{ ...item, qty: 0 }] } })).status).toBe(422)
    expect((await harness.call('POST', PATH, { body: { items: [item], dryRun: 'no' } })).status).toBe(422)
    expect((await harness.call('POST', PATH, { body: { items: [item], force: true } })).status).toBe(422)
    expect((await harness.call('POST', PATH, { body: { items: [{ ...item, supplierId: 's' }] } })).status).toBe(422)
  })

  it('意向清单：筛选与排序取值不合格 422', async () => {
    harness = await createTestApp(sessionStub(['replenishment.read']))
    expect((await harness.call('GET', '/replenishment/intents?status=DONE')).status).toBe(422)
    expect((await harness.call('GET', '/replenishment/intents?sort=sku:asc')).status).toBe(422)
  })
})
