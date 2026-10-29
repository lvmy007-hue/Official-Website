import type { EvidenceLine, EvidenceManifest } from '@nova/api-contracts'
import type { ExportRow, SourceContext } from './sources'

// 赔付证据包导出（P2b-03）：按证据包生成当时保存的清单逐行输出，不读现势数据，所以包生成之后证据怎么变都不影响已导出的内容。
// 范围校验：案件所在店铺必须在发起人当前的数据范围内。

const isManifest = (value: unknown): value is EvidenceManifest => typeof value === 'object' && value !== null && Array.isArray((value as EvidenceManifest).lines)

export async function* reimbursementEvidence({ db, tenantId, filters, storeIds }: SourceContext): AsyncGenerator<ExportRow> {
  const packId = typeof filters.packId === 'string' ? filters.packId : ''
  if (!packId) throw new Error('证据包编号缺失')
  const pack = await db.evidencePack.findFirst({ where: { id: packId, tenantId }, select: { contentManifestJson: true, reimbursementCase: { select: { sellerAccountId: true } } } })
  if (!pack || !isManifest(pack.contentManifestJson)) throw new Error('证据包不存在')
  if (storeIds && !storeIds.includes(pack.reimbursementCase.sellerAccountId)) throw new Error('证据包所属店铺不在发起人的数据范围内')
  for (const line of pack.contentManifestJson.lines as EvidenceLine[]) yield { section: line.section, item: line.item, detail: line.detail, at: line.at ?? null }
}
