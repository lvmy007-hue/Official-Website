import { Injectable } from '@nestjs/common'
import { PII_REVEAL_ACTION, PII_REVEAL_AUTO_HIDE_SECONDS, PII_REVEAL_PERMISSION, PiiRevealBodySchema, type PiiObjectType, type PiiRevealResponse, type PiiRevealState } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import type { PiiSource } from '../../platform/security/pii-source'
import { SecretBoxService } from '../../platform/security/secret-box.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'
import { OrdersPiiSource } from '../orders'
import { ReturnsPiiSource } from '../returns'
import { SupportPiiSource } from '../support'

// 个人信息统一出口（P6-14）：全站唯一会返回个人信息明文的地方，也是接口服务里唯一调用买家信息解密的地方。
// 流程固定为：权限（field.buyer）→ 校验请求（理由必填、字段必须属于该对象）→ 对象所属功能的读权限与数据范围（越权与跨企业一律 404）
//   → 解密 → 写审计 → 才把明文放进响应。审计只记对象、字段名、理由与结果，绝不含明文；审计写不进去就不返回明文。
// 没有可展示内容（从未同步、已过保留期、没有正文）时如实说明，也写审计，不返回空壳。明文不进日志、列表、详情与导出。
@Injectable()
export class PiiRevealService {
  private readonly sources: Readonly<Record<PiiObjectType, PiiSource>>

  constructor(
    private readonly context: ContextService,
    private readonly secrets: SecretBoxService,
    private readonly audit: AuditWriter,
    orders: OrdersPiiSource,
    returns: ReturnsPiiSource,
    support: SupportPiiSource,
  ) {
    this.sources = { ORDER: orders, RETURN: returns, SUPPORT_CONTACT: support }
  }

  async reveal(req: RequestWithContext, rawBody: unknown): Promise<PiiRevealResponse> {
    await this.context.authorize(req, PII_REVEAL_PERMISSION)
    const body = PiiRevealBodySchema.parse(rawBody ?? {})
    const record = await this.sources[body.objectType].open(req, body.objectId)
    const now = Date.now()
    // 审计只记字段名（审计中心的“个人信息明文查看”视图显示“看了哪些字段”），绝不记内容
    const write = (outcome: PiiRevealState, fields?: string[]) =>
      this.audit.record(req, {
        action: PII_REVEAL_ACTION,
        resourceType: record.resourceType,
        resourceId: record.resourceId,
        reason: body.reason,
        detail: { ...record.detail, objectType: body.objectType, objectId: body.objectId, outcome, requested: body.fields, ...(fields ? { fields } : {}) },
      })
    const none = async (state: Exclude<PiiRevealState, 'OK'>): Promise<PiiRevealResponse> => {
      await write(state)
      return { objectType: body.objectType, objectId: body.objectId, state, values: {}, expiresAt: null, retainedUntil: record.retainedUntil?.toISOString() ?? null, note: record.notes[state] }
    }

    const stored = record.stored
    let values: Record<string, string | null>
    if (stored.kind === 'NONE') return none(record.retainedUntil ? 'EXPIRED' : 'NOT_SYNCED')
    if (stored.kind === 'PLAIN') {
      values = Object.fromEntries(body.fields.map(field => [field, stored.values[field] || null]))
    } else {
      // 加密保存的内容要在保留期内才给；到期但后台任务还没清除的，等同已过期
      if (!record.retainedUntil || record.retainedUntil.getTime() <= now) return none(record.retainedUntil ? 'EXPIRED' : 'NOT_SYNCED')
      const opened = await this.secrets.openBuyerPii(stored.ciphertext)
      values = stored.kind === 'SEALED_JSON' ? pick(JSON.parse(opened) as Record<string, unknown>, body.fields) : { [stored.field]: opened || null }
      // 文本类内容只有一个字段：请求里别的字段不会出现在结果里
      values = Object.fromEntries(body.fields.map(field => [field, values[field] ?? null]))
    }
    const present = body.fields.filter(field => values[field])
    if (present.length === 0) return none('NOT_SYNCED')
    await write('OK', present)
    const hideAt = now + PII_REVEAL_AUTO_HIDE_SECONDS * 1000
    const until = record.retainedUntil ? Math.min(hideAt, record.retainedUntil.getTime()) : hideAt
    return {
      objectType: body.objectType,
      objectId: body.objectId,
      state: 'OK',
      values,
      expiresAt: new Date(until).toISOString(),
      retainedUntil: record.retainedUntil?.toISOString() ?? null,
      note: null,
    }
  }
}

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(fields.map(field => [field, typeof source[field] === 'string' && source[field] ? (source[field] as string) : null]))
}
