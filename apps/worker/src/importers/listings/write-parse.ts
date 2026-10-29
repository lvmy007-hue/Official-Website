import { LISTING_WRITE_LIMITS, type ListingBatchRowResult, type ListingValidationIssue } from '@nova/api-contracts'

// 刊登写入与查询的响应解析（修改与校验预览、刊登限制、批量任务结果文件）。字段依据亚马逊官方文档整理，未经真实响应核对（CR-085 未验证清单）。
// 原则：亚马逊返回的文字只截断长度后保存（不含令牌与个人信息）；认不出的结构不猜——修改与校验的响应没有 status 字段按“无法确认”处理，由调用方当作失败。

const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const clip = (value: string) => value.slice(0, LISTING_WRITE_LIMITS.resultTextMax)

export function parseValidationIssues(raw: unknown): ListingValidationIssue[] {
  const out: ListingValidationIssue[] = []
  for (const entry of list(raw)) {
    const issue = obj(entry)
    if (!issue) continue
    const code = str(issue.code)
    if (!code) continue
    out.push({
      code: code.slice(0, 120),
      severity: str(issue.severity).toUpperCase() || 'ERROR',
      message: clip(str(issue.message) || code),
      attributeNames: list(issue.attributeNames).map(str).filter(Boolean).slice(0, 10),
    })
    if (out.length >= LISTING_WRITE_LIMITS.runRowsMax) break
  }
  return out
}

export interface PatchResponse {
  /** ACCEPTED（已接受）/ VALID（校验预览通过）/ INVALID（有错误）；认不出为 null。 */
  status: 'ACCEPTED' | 'VALID' | 'INVALID' | null
  issues: ListingValidationIssue[]
  submissionId: string | null
}
export function parsePatchResponse(raw: unknown): PatchResponse {
  const root = obj(raw) ?? {}
  const status = str(root.status).toUpperCase()
  return {
    status: status === 'ACCEPTED' || status === 'VALID' || status === 'INVALID' ? status : null,
    issues: parseValidationIssues(root.issues),
    submissionId: str(root.submissionId) || null,
  }
}
/** 有错误级问题就算无效（亚马逊的 status 以外再兜一层：INVALID 的响应必有错误，但响应写 VALID 却带错误级问题时也不放行）。 */
export const hasErrorIssue = (issues: readonly ListingValidationIssue[]) => issues.some(issue => issue.severity === 'ERROR')

export interface RestrictionRow {
  asin: string
  restricted: boolean
  reasons: Array<{ code: string; message: string; link: string | null }>
  /** 没能查到（ASIN 不存在等）时的原因代码。 */
  error: string | null
}
export function parseRestrictions(asin: string, raw: unknown): RestrictionRow {
  const reasons: RestrictionRow['reasons'] = []
  for (const restriction of list(obj(raw)?.restrictions)) {
    for (const reason of list(obj(restriction)?.reasons)) {
      const item = obj(reason)
      if (!item) continue
      const link = list(item.links)
        .map(obj)
        .find(entry => entry && str(entry.resource))
      reasons.push({ code: str(item.reasonCode).slice(0, 60) || 'UNKNOWN', message: clip(str(item.message)), link: link ? str(link.resource).slice(0, 500) : null })
    }
  }
  // 响应里没有任何限制 = 当前账户可以刊登这个 ASIN（官方文档：restrictions 为空数组表示无限制）
  return { asin, restricted: reasons.length > 0, reasons: reasons.slice(0, 10), error: null }
}

/** 批量任务结果文件 → 逐个商品的结果（消息编号从 1 起对应提交顺序）；有错误级问题的商品记为失败，只有警告的记为成功。 */
export function parseFeedResult(raw: unknown, skus: readonly string[]): ListingBatchRowResult[] {
  const root = obj(raw) ?? {}
  const byMessage = new Map<number, ListingValidationIssue[]>()
  for (const entry of list(root.issues)) {
    const issue = obj(entry)
    const id = Number(issue?.messageId)
    if (!issue || !Number.isInteger(id)) continue
    const parsed = parseValidationIssues([issue])
    if (parsed.length > 0) byMessage.set(id, [...(byMessage.get(id) ?? []), ...parsed])
  }
  return skus.map((sku, index) => {
    const issues = byMessage.get(index + 1) ?? []
    return { sku, ok: !hasErrorIssue(issues), issues: issues.slice(0, 10) }
  })
}
