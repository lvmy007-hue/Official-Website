import { Injectable } from '@nestjs/common'
import { buildSourceHealth, type PendingSection } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { FreshnessService } from '../freshness'
import { OverviewContextService } from './overview-context.service'

export const AD_ANOMALY_PENDING: PendingSection = {
  state: 'NOT_CONNECTED',
  note: '广告异常（高花费无成交、超预算时长、广告成本销售比突增）来自广告报表与预警，广告同步在阶段 3 交付，目前尚未接入',
  workPackage: 'P3',
}
export const INVENTORY_RISK_PENDING: PendingSection = {
  state: 'NOT_CONNECTED',
  note: '库存风险分布（断货、冗余、库龄附加费、低库存水平费）来自库存规则引擎，随 P2a-05、P2a-06 交付，目前尚未接入',
  workPackage: 'P2a-06',
}

// 经营控制台：数据源健康（阶段 1 已有）与尚未交付的区域（广告异常、库存风险）。
// 尚未交付的区域也要求 overview.read，并如实返回“尚未接入”，不返回任何示例数字。
@Injectable()
export class OverviewService {
  constructor(
    private readonly freshness: FreshnessService,
    private readonly base: OverviewContextService,
  ) {}

  // 要求 overview.read；范围按本人数据授权收窄。没有同步记录的来源如实显示“尚无记录”。
  async sourceHealth(req: RequestWithContext, query: Record<string, string>) {
    const result = await this.freshness.get(req, query, 'overview.read')
    return { asOf: result.asOf, storeCount: result.storeCount, rows: buildSourceHealth(result.sources), summary: result.summary }
  }

  async adAnomalies(req: RequestWithContext, query: Record<string, string>): Promise<PendingSection> {
    await this.base.prepare(req, query)
    return AD_ANOMALY_PENDING
  }

  async inventoryRisk(req: RequestWithContext, query: Record<string, string>): Promise<PendingSection> {
    await this.base.prepare(req, query)
    return INVENTORY_RISK_PENDING
  }
}
