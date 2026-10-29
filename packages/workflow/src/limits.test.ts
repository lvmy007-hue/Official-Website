import { describe, expect, it } from 'vitest'
import { MAX_QUEUE_PAYLOAD_BYTES, QueuePayloadTooLargeError, allocateConcurrency, assertQueuePayload } from './limits'

describe('队列消息体上限', () => {
  it('只含编号与参数的消息通过', () => {
    expect(() => assertQueuePayload({ tenantId: 't1', syncJobId: 'j1', requestId: 'r1', marketplaceId: 'ATVPDKIKX0DER' })).not.toThrow()
  })

  it('把大对象塞进消息会被拒绝，并说明应放对象存储', () => {
    const big = { tenantId: 't1', rows: 'x'.repeat(MAX_QUEUE_PAYLOAD_BYTES) }
    expect(() => assertQueuePayload(big)).toThrow(QueuePayloadTooLargeError)
    expect(() => assertQueuePayload(big)).toThrow('对象存储')
  })

  it('按字节而不是字符数计算（中文占 3 字节）', () => {
    expect(() => assertQueuePayload({ text: '汉'.repeat(6000) })).toThrow(QueuePayloadTooLargeError)
    expect(() => assertQueuePayload({ text: '汉'.repeat(1000) })).not.toThrow()
  })
})

describe('按内存预算分配并发', () => {
  const requested = { a: 2, b: 2, c: 3, d: 2 }

  it('预算够用：原样返回', () => {
    expect(allocateConcurrency(requested, { budgetMb: 1024, perJobMb: 64 })).toEqual(requested)
  })

  it('预算不足：按比例缩小，总数不超过预算对应的槽位，每个队列至少 1', () => {
    const result = allocateConcurrency(requested, { budgetMb: 256, perJobMb: 64 })
    const sum = Object.values(result).reduce((a, b) => a + b, 0)
    expect(sum).toBeLessThanOrEqual(4)
    for (const value of Object.values(result)) expect(value).toBeGreaterThanOrEqual(1)
    expect(result.c).toBeGreaterThanOrEqual(result.a)
  })

  it('预算极小：每个队列仍保留 1 个并发', () => {
    expect(allocateConcurrency(requested, { budgetMb: 1, perJobMb: 64 })).toEqual({ a: 1, b: 1, c: 1, d: 1 })
  })
})
