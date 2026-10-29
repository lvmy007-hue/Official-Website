import { createHash } from 'node:crypto'
import {
  LISTING_BATCH_SWITCH,
  LISTING_QUALITY_WRITE,
  LISTING_RUN_KIND_LABEL,
  LISTING_RUN_STATUS_LABEL,
  LISTING_UPDATE_SWITCH,
  LISTING_WRITE_LIMITS,
  listingFailureText,
  listingPatchesText,
  type ListingBatchRowResult,
  type ListingPatchInput,
  type ListingRunKind,
  type ListingRunStatus,
  type ListingRunView,
  type ListingValidationIssue,
  type ListingWriteStatus,
  type ListingWriteStatuses,
} from '@nova/api-contracts'
import type { ListingWriteRun } from '@prisma/client'
import type { ApiContext } from '../../platform/http'
import type { ActionGuardService } from '../../platform/write'

// 刊登写入记录的视图与校验预览令牌（P4-10）。记录里的 requestJson 只含 SKU、商品类型与修改项，不含令牌与个人信息。

/** 校验预览令牌：提交时的 SKU、商品类型与修改项必须与校验过的完全一致，用摘要核对。 */
export const patchHash = (sku: string, productType: string, patches: readonly ListingPatchInput[]) =>
  createHash('sha256')
    .update(listingPatchesText(sku, productType, patches))
    .digest('hex')

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

export interface RunNames {
  stores: ReadonlyMap<string, string>
  users: ReadonlyMap<string, string>
}

export function runViewOf(run: ListingWriteRun, names: RunNames, now: Date): ListingRunView {
  const result = record(run.resultJson)
  const rows = list<ListingBatchRowResult>(result.rows).slice(0, LISTING_WRITE_LIMITS.runRowsMax)
  const validUntil = (run.kind === 'VALIDATE' || run.kind === 'PRICE_VALIDATE') && run.validation === 'VALID' && run.expiresAt && run.expiresAt > now ? run.expiresAt : null
  return {
    id: run.id,
    kind: run.kind as ListingRunKind,
    kindLabel: LISTING_RUN_KIND_LABEL[run.kind as ListingRunKind] ?? run.kind,
    status: run.status as ListingRunStatus,
    statusLabel: LISTING_RUN_STATUS_LABEL[run.status as ListingRunStatus] ?? run.status,
    storeId: run.sellerAccountId,
    storeName: names.stores.get(run.sellerAccountId) ?? '',
    sku: run.sellerSku,
    productType: run.productType,
    validation: run.validation === 'VALID' || run.validation === 'INVALID' ? run.validation : null,
    previewRunId: run.previewRunId,
    itemCount: run.itemCount,
    issues: list<ListingValidationIssue>(run.issuesJson).slice(0, LISTING_WRITE_LIMITS.runRowsMax),
    rows,
    summary:
      run.kind === 'BATCH' && rows.length > 0
        ? { accepted: Number(result.accepted ?? rows.filter(row => row.ok).length), invalid: Number(result.invalid ?? rows.filter(row => !row.ok).length) }
        : null,
    failureCode: run.failureCode,
    failureText: run.status === 'FAILED' ? listingFailureText(run.failureCode) : null,
    requestedBy: run.requestedBy ? (names.users.get(run.requestedBy) ?? null) : null,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    usableUntil: validUntil ? validUntil.toISOString() : null,
  }
}

/** 三类写入通道的状态（权限 → 卖家连接 → 开关）；连接按“范围内任意一家店铺已授权”判断，具体店铺在提交时再校验。 */
export async function writeStatusesOf(guard: ActionGuardService, context: ApiContext): Promise<ListingWriteStatuses> {
  const statusOf = async (switchKey?: string): Promise<ListingWriteStatus> => {
    const decision = await guard.evaluate(context, { permission: LISTING_QUALITY_WRITE, connection: { provider: 'AMAZON_SP_API' }, ...(switchKey ? { switchKey } : {}) })
    if (decision.allowed || !decision.blockedBy) return { allowed: true, step: null, reason: null, remedyPath: null }
    const block = decision.blockedBy
    const step = block.step === 'PERMISSION' || block.step === 'CONNECTION' || block.step === 'SWITCH' ? block.step : null
    return { allowed: false, step, reason: block.message, remedyPath: block.remedy?.path ?? null }
  }
  const [validate, update, batch] = await Promise.all([statusOf(), statusOf(LISTING_UPDATE_SWITCH), statusOf(LISTING_BATCH_SWITCH)])
  return { validate, update, batch }
}
