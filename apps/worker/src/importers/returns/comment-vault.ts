import { RETURN_COMMENT_MAX_CHARS, detectPiiKinds, kindsToText } from '@nova/api-contracts'
import type { PiiSealer } from '../../crypto/secrets'
import { PII_RETENTION_DAYS } from '../orders/v2026-write'

// 退货买家备注的加密保存（P6-14）：与订单买家信息同一套密钥（buyer-pii）和保留规则，明文从不落库、不进日志。
//   - 保留期：从发货日起算（还不知道发货日时从退货日起算，订单回填后会缩短），天数取企业设置与 30 天里较小的一个；
//   - 已经到期的备注不再写入（避免刚写入就被清理任务清空）；
//   - 同时记下自动识别出的个人信息类别（电话、邮箱、地址），详情页据此提示，类别不含任何内容。

const DAY_MS = 86_400_000

export interface SealedComment {
  customerCommentsCipher: string
  customerCommentsExpiresAt: Date
  customerCommentsKinds: string
}

/** 备注保留期截止：发货日（没有就用退货日）加保留天数；保留天数不超过 30 天。 */
export function commentExpiry(input: { shippedAt?: Date | null; returnDate: Date; retentionDays?: number }): Date {
  const days = Math.min(input.retentionDays ?? PII_RETENTION_DAYS, PII_RETENTION_DAYS)
  return new Date((input.shippedAt ?? input.returnDate).getTime() + days * DAY_MS)
}

/** 加密一条备注；已到期、空白或没有加密能力时返回 null（调用方不写备注列）。超长按契约上限截断。 */
export async function sealComment(
  secrets: PiiSealer | undefined,
  text: string | undefined,
  input: { returnDate: Date; shippedAt?: Date | null; retentionDays?: number; now: Date },
): Promise<SealedComment | null> {
  const clean = text?.trim()
  if (!clean || !secrets) return null
  const expiresAt = commentExpiry(input)
  if (expiresAt.getTime() <= input.now.getTime()) return null
  const body = clean.slice(0, RETURN_COMMENT_MAX_CHARS)
  return {
    customerCommentsCipher: await secrets.sealBuyerPii(body),
    customerCommentsExpiresAt: expiresAt,
    customerCommentsKinds: kindsToText(detectPiiKinds(body)),
  }
}
