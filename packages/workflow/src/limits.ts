// 资源上限（12.5 内存溢出防护）：队列消息只存编号与参数；并发数按内存预算设定。

/** 队列消息体上限：只放编号与参数，大对象一律放对象存储。 */
export const MAX_QUEUE_PAYLOAD_BYTES = 16 * 1024

export class QueuePayloadTooLargeError extends Error {
  readonly code = 'QUEUE_PAYLOAD_TOO_LARGE'
  constructor(
    public readonly bytes: number,
    public readonly maxBytes: number,
  ) {
    super(`队列消息体 ${bytes} 字节，超过上限 ${maxBytes} 字节：队列里只能放编号与参数，大对象请放对象存储`)
    this.name = 'QueuePayloadTooLargeError'
  }
}

/** 入队前检查消息体大小；超限是代码缺陷，直接抛错（不入队）。 */
export function assertQueuePayload(data: unknown, maxBytes = MAX_QUEUE_PAYLOAD_BYTES): void {
  const bytes = Buffer.byteLength(JSON.stringify(data ?? null), 'utf8')
  if (bytes > maxBytes) throw new QueuePayloadTooLargeError(bytes, maxBytes)
}

export interface MemoryBudget {
  /** 可用于并发任务的内存预算（MB）。 */
  budgetMb: number
  /** 单个任务的内存估算（MB）：流式处理后，单个任务的占用与文件大小无关，只与批大小有关。 */
  perJobMb: number
}

/**
 * 按内存预算分配各队列的并发：总并发 ≤ 预算 / 单任务估算；预算够用时原样返回，不够时按比例缩小，
 * 每个队列至少保留 1（否则该队列的任务永远不会被处理）。
 */
export function allocateConcurrency(requested: Record<string, number>, budget: MemoryBudget): Record<string, number> {
  const names = Object.keys(requested)
  const total = names.reduce((sum, name) => sum + requested[name], 0)
  const slots = Math.max(1, Math.floor(budget.budgetMb / Math.max(1, budget.perJobMb)))
  if (total <= slots) return { ...requested }
  const scaled: Record<string, number> = {}
  for (const name of names) scaled[name] = Math.max(1, Math.floor((requested[name] * slots) / total))
  return scaled
}
