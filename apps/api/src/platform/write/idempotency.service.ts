import { Injectable } from '@nestjs/common'
import { IDEMPOTENCY_TTL_HOURS } from '@nova/api-contracts'
import { createHash } from 'node:crypto'
import { appError } from '../http'
import { PrismaService } from '../prisma.service'

// 幂等：同一企业、同一路由、同一幂等键 24 小时内只执行一次，重复提交返回首次结果。
// 处理中的记录超过该时间仍未完成，视为上次处理已中断（进程崩溃等），允许重新执行。
export const IN_PROGRESS_STALE_MS = 2 * 60 * 1000
// 响应体超过该大小不保存（写接口响应都很小，超限说明设计有问题）；此时记录被释放，重复提交会重新执行。
const MAX_STORED_BYTES = 256 * 1024

export type IdempotencyBegin = { state: 'new'; recordId: string } | { state: 'replay'; status: number; body: unknown }

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002'

// 键按字母序排列后序列化，保证“同样的内容”得到同样的摘要
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export const requestFingerprint = (parts: { method: string; route: string; params: unknown; query: unknown; body: unknown }) => createHash('sha256').update(canonical(parts)).digest('hex')

@Injectable()
export class IdempotencyService {
  private lastPurge = 0

  constructor(private readonly prisma: PrismaService) {}

  async begin(tenantId: string, key: string, route: string, requestHash: string): Promise<IdempotencyBegin> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = new Date()
      try {
        const record = await this.prisma.idempotencyRecord.create({
          data: { tenantId, key, route, requestHash, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_HOURS * 3600_000) },
          select: { id: true },
        })
        return { state: 'new', recordId: record.id }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
      }
      const existing = await this.prisma.idempotencyRecord.findUnique({ where: { tenantId_key_route: { tenantId, key, route } } })
      if (!existing) continue
      if (existing.expiresAt <= now) {
        await this.prisma.idempotencyRecord.deleteMany({ where: { id: existing.id, expiresAt: { lte: now } } })
        continue
      }
      if (existing.requestHash !== requestHash) {
        throw appError('IDEMPOTENCY_KEY_REUSED', '该幂等键已用于内容不同的请求，请使用新的幂等键')
      }
      if (existing.responseStatus !== null && existing.responseStatus !== undefined) {
        return { state: 'replay', status: existing.responseStatus, body: existing.responseJson }
      }
      if (now.getTime() - existing.createdAt.getTime() > IN_PROGRESS_STALE_MS) {
        // 接管已中断的处理：只有一个请求能抢到
        const taken = await this.prisma.idempotencyRecord.updateMany({
          where: { id: existing.id, responseStatus: null, createdAt: existing.createdAt },
          data: { createdAt: now },
        })
        if (taken.count === 1) return { state: 'new', recordId: existing.id }
        continue
      }
      throw appError('IDEMPOTENCY_IN_PROGRESS', '相同的请求正在处理中，请稍后查看结果，不要重复提交')
    }
    throw appError('IDEMPOTENCY_IN_PROGRESS', '相同的请求正在处理中，请稍后查看结果，不要重复提交')
  }

  /** 保存首次结果；响应体过大时释放记录。 */
  async complete(recordId: string, status: number, body: unknown) {
    const json = JSON.stringify(body ?? null)
    if (Buffer.byteLength(json) > MAX_STORED_BYTES) {
      await this.release(recordId)
      return
    }
    await this.prisma.idempotencyRecord.update({ where: { id: recordId }, data: { responseStatus: status, responseJson: JSON.parse(json) } })
  }

  /** 失败时释放：客户端修正后可以用同一个键重试。 */
  async release(recordId: string) {
    await this.prisma.idempotencyRecord.deleteMany({ where: { id: recordId, responseStatus: null } })
  }

  /** 清理过期记录；请求路径上每分钟最多触发一次，后台任务也可直接调用。 */
  async purgeExpired(limit = 1000): Promise<number> {
    const expired = await this.prisma.idempotencyRecord.findMany({ where: { expiresAt: { lte: new Date() } }, select: { id: true }, take: limit })
    if (expired.length === 0) return 0
    const result = await this.prisma.idempotencyRecord.deleteMany({ where: { id: { in: expired.map(item => item.id) } } })
    return result.count
  }

  purgeOpportunistically() {
    const now = Date.now()
    if (now - this.lastPurge < 60_000) return
    this.lastPurge = now
    void this.purgeExpired().catch(() => undefined)
  }
}
