import { Injectable } from '@nestjs/common'
import type { AmazonReplenishment, InventoryReplenishmentResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { diffReasons, InventoryItemService } from '../inventory'
import { amazonViewOf, calculate } from './replenishment-compute.service'
import { ReplenishmentLoaderService } from './replenishment-loader.service'
import { ReplenishmentPolicyService } from './replenishment-policy.service'
import { asInventoryPolicy, indexPolicies, pickPolicy } from './replenishment-resolve'

// 库存详情“补货建议”页签（06 章 6.1 第 6 页签）：现算的单品结果，与补货建议批次用同一套计算链，并和亚马逊官方建议双源核对。
@Injectable()
export class ReplenishmentSkuService {
  constructor(
    private readonly items: InventoryItemService,
    private readonly loader: ReplenishmentLoaderService,
    private readonly policies: ReplenishmentPolicyService,
  ) {}

  async forInventory(req: RequestWithContext, id: string): Promise<InventoryReplenishmentResponse> {
    const { context, scope, today, item: built } = await this.items.resolve(req, id, ['replenishment.read'])
    const { items } = await this.loader.load({ tenantId: context.tenantId, scope, today, ids: [id] })
    const item = items[0] ?? { row: built.row, category: null, subscribe: null, restock: null, awdQty: null, overrides: [] }
    const policy = pickPolicy(indexPolicies(await this.policies.effectiveOf(context.tenantId, today)), item.row.sku, item.category)
    const calc = calculate(item, policy, today)
    const { row } = item
    const amazon: AmazonReplenishment =
      amazonViewOf(item) ??
      (row.advice.amazonShipInQty !== null || row.advice.amazonShipInDate
        ? {
            state: 'OK',
            note: '没有补货建议报告，数据取自库存规划报告',
            recommendedQty: row.advice.amazonShipInQty,
            recommendedShipDate: row.advice.amazonShipInDate,
            alertReason: null,
            recommendedAction: row.advice.amazonAction,
            source: 'PLANNING_REPORT',
            snapshotDate: row.dates.planningDate,
          }
        : {
            state: 'NO_DATA',
            note: '尚无亚马逊补货建议；补货建议报告同步后这里会出现',
            recommendedQty: null,
            recommendedShipDate: null,
            alertReason: null,
            recommendedAction: null,
            source: null,
            snapshotDate: null,
          })
    const oursQty = calc.state === 'OK' || calc.state === 'NO_NEED' ? calc.recommendedQty : null
    const q = row.quantity
    return {
      ours: calc,
      amazon,
      diffQty: oursQty !== null && amazon.recommendedQty !== null ? oursQty - amazon.recommendedQty : null,
      diffReasons: diffReasons({
        oursQty,
        amazon,
        amazonUnits30: item.restock?.unitsSold30d ?? null,
        demand: row.demand,
        policy: policy ? asInventoryPolicy(policy) : null,
        inbound: { working: q.inboundWorking, shipped: q.inboundShipped, receiving: q.inboundReceiving },
      }),
    }
  }
}
