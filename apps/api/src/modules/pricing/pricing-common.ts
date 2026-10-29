import { PRICING_PRICE_WRITE, PRICING_RULE_WRITE, PRICING_UPDATE_SWITCH, type CursorPageInfo, type PricingWriteStatus, type PricingWriteStatuses } from '@nova/api-contracts'
import { AppError, type ApiContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { createCursorCodec, resolveCursorKey } from '../../platform/query'
import type { ActionGuardService } from '../../platform/write'
import { storeWhere, type ResolvedScope } from '../auth'

// 定价模块的公共部分（P4-11）：偏移游标（签名并绑定全部条件，与刊登表现同一做法；模块之间只能经 index 引用，这里各留一份很小的实现）、写入通道状态、可见店铺。

let codec: ReturnType<typeof createCursorCodec> | undefined
const cursorCodec = () => (codec ??= createCursorCodec(resolveCursorKey()))
const invalid = () => new AppError(400, 'CURSOR_INVALID', '翻页游标无效或查询条件已变化，请从第一页重新加载')

export function decodeOffset(token: string | undefined, binding: string): number {
  if (!token) return 0
  const payload = cursorCodec().decode(token)
  const offset = Number(payload.k)
  if (payload.b !== binding || payload.f !== 'offset' || !Number.isInteger(offset) || offset < 0) throw invalid()
  return offset
}

export function pageInfoAt(offset: number, count: number, total: number, pageSize: number, binding: string): CursorPageInfo {
  const end = offset + count
  const hasMore = end < total
  const nextCursor = hasMore ? cursorCodec().encode({ v: 1, b: binding, f: 'offset', r: 'asc', t: 'n', k: String(end), i: '' }) : null
  return { pageSize, nextCursor, hasMore, approxTotal: total }
}

export function pageOf<T>(items: readonly T[], offset: number, pageSize: number, binding: string): { page: T[]; pageInfo: CursorPageInfo } {
  const page = items.slice(offset, offset + pageSize)
  return { page, pageInfo: pageInfoAt(offset, page.length, items.length, pageSize, binding) }
}

export async function storesOf(prisma: PrismaService, tenantId: string, scope: ResolvedScope): Promise<Array<{ id: string; name: string }>> {
  const rows = await prisma.sellerAccount.findMany({
    where: { tenantId, ...storeWhere(scope, 'id') },
    select: { id: true, displayName: true },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: 500,
  })
  return rows.map(row => ({ id: row.id, name: row.displayName }))
}

/** 三类写入通道的状态：校验预览（权限 + 卖家连接）、改价（再加开关 sw.pricing.update）、规则与护栏（只要权限）。连接按“范围内任意一家店铺已授权”判断，具体店铺在提交时再校验。 */
export async function writeStatusesOf(guard: ActionGuardService, context: ApiContext): Promise<PricingWriteStatuses> {
  const statusOf = async (input: Parameters<ActionGuardService['evaluate']>[1]): Promise<PricingWriteStatus> => {
    const decision = await guard.evaluate(context, input)
    if (decision.allowed || !decision.blockedBy) return { allowed: true, step: null, reason: null, remedyPath: null }
    const block = decision.blockedBy
    const step = block.step === 'PERMISSION' || block.step === 'CONNECTION' || block.step === 'SWITCH' ? block.step : null
    return { allowed: false, step, reason: block.message, remedyPath: block.remedy?.path ?? null }
  }
  const [validate, update, rule] = await Promise.all([
    statusOf({ permission: PRICING_PRICE_WRITE, connection: { provider: 'AMAZON_SP_API' } }),
    statusOf({ permission: PRICING_PRICE_WRITE, connection: { provider: 'AMAZON_SP_API' }, switchKey: PRICING_UPDATE_SWITCH }),
    statusOf({ permission: PRICING_RULE_WRITE }),
  ])
  return { validate, update, rule }
}
