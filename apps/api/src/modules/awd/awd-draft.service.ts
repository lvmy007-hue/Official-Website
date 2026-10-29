import { randomBytes } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

export interface AwdDraftInput {
  tenantId: string
  userId: string
  batchId: string
  batchNo: string
  /** 同一店铺的建议合成一张订单（亚马逊的入库订单属于一个卖家账号）。 */
  stores: Array<{ sellerAccountId: string; items: Array<{ recommendationId: string; sku: string; qty: number }> }>
}

export interface AwdDraftRef {
  id: string
  sellerAccountId: string
  reference: string
  lineCount: number
  recommendationIds: string[]
}

// 补货建议生成上游仓储入库订单草稿：只在本地创建“本地草稿”（LOCAL_DRAFT），不调用亚马逊。
// 草稿只带 SKU 与数量，包装（箱或托盘）、尺寸重量与发货地址要人工补全后才能提交；补货模块通过本服务建单，不直接写 AWD 的表。
@Injectable()
export class AwdDraftService {
  async createFromReplenishment(tx: Prisma.TransactionClient, input: AwdDraftInput): Promise<AwdDraftRef[]> {
    const refs: AwdDraftRef[] = []
    for (const store of input.stores) {
      const units = store.items.reduce((sum, item) => sum + item.qty, 0)
      const created = await tx.awdInboundOrder.create({
        data: {
          tenantId: input.tenantId,
          sellerAccountId: store.sellerAccountId,
          externalReferenceId: `NOVA-${randomBytes(6).toString('hex').toUpperCase()}`,
          status: 'LOCAL_DRAFT',
          expectedUnits: units,
          draftJson: { source: 'REPLENISHMENT', batchId: input.batchId, batchNo: input.batchNo, items: store.items.map(item => ({ sku: item.sku, qty: item.qty })) },
          note: `由补货批次 ${input.batchNo} 生成的草稿；请补全包装、尺寸重量与发货地址后再提交亚马逊`,
          createdBy: input.userId,
        },
      })
      refs.push({
        id: created.id,
        sellerAccountId: store.sellerAccountId,
        reference: created.externalReferenceId as string,
        lineCount: store.items.length,
        recommendationIds: store.items.map(item => item.recommendationId),
      })
    }
    return refs
  }
}
