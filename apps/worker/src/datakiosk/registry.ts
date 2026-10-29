import type { RowOutcome } from '../streaming/batch'
import type { Row } from '../streaming/rows'
import type { ImportContext } from '../types'

// 数据中心数据集注册表。每个数据集是一个“查询文本生成器 + 结果行落库器”，由后续工作包各自注册：
// 销售与流量（P2b-11 之后接入利润口径时）、品牌分析、市场篮子等。执行器本身与具体数据集无关。

export type KioskScope = { tenantId: string; sellerAccountId: string }

export interface DataKioskDataset {
  /** 数据集标识，任务上下文里用它指定要跑哪个数据集。 */
  id: string
  /** 由任务参数生成查询文本（GraphQL）。参数由调用方校验，这里只负责拼装；不得拼入未转义的外部输入。 */
  buildQuery(params: Record<string, string>): string
  /** 处理结果里的一行（一条 JSON 记录）。在分批事务内被调用，使用传入的 ctx.prisma。 */
  handle(ctx: ImportContext, row: Row, scope: KioskScope, params: Record<string, string>): Promise<RowOutcome>
  /** 留存与登记用：这个数据集的原始结果归到哪个报告类型名下（RawReportFile.reportType）。 */
  reportType: string
  /** 亚马逊以 403 拒绝这个数据集的查询时（缺少所需角色）用的专属失败码与说明；不填就按通用的 ROLE_MISSING 处理。例如销售与流量的 DK_NO_BRAND。 */
  roleMissing?: { code: string; message: string }
}

const datasets = new Map<string, DataKioskDataset>()

export function registerDataKioskDataset(dataset: DataKioskDataset): void {
  if (datasets.has(dataset.id)) throw new Error(`DATA_KIOSK_DATASET_DUPLICATE:${dataset.id}`)
  datasets.set(dataset.id, dataset)
}

export const dataKioskDatasetFor = (id: string): DataKioskDataset | undefined => datasets.get(id)
export const registeredDataKioskDatasets = () => [...datasets.keys()]
/** 仅测试使用：清空注册表。 */
export const clearDataKioskDatasetsForTest = () => datasets.clear()
