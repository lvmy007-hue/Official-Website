import { Injectable } from '@nestjs/common'
import {
  ECONOMICS_COMPARE_MAX_DAYS,
  ECONOMICS_OURS_CURRENCY,
  ECONOMICS_READ,
  PROFIT_BASIS_LABEL,
  PROFIT_BASIS_NOTE,
  ProfitQuerySchema,
  ScopeSearchSchema,
  type Asin360CostsResponse,
  type Asin360OfficialResponse,
  type Asin360PreviewResponse,
} from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { CostsDetailService } from '../costs'
import { EconomicsSkuService } from '../economics'
import { resolvePeriods, todayIn, validZone } from '../overview'
import { ProductAccessService, type ProductAccess } from './product-access.service'

const NO_OFFICIAL_NOTE =
  '这个商品在所选范围内没有官方单品经济记录：店铺授权卖家账号并开通“卖家洞察”角色后，亚马逊数据中心每天同步一次（第一次回补最近 90 天）；官方也只返回有资格的商品。没有记录时不显示成 0。'
const OFFICIAL_NOTES = [
  '成本口径只在官方与我方都有成本时核对：官方成本是卖家在亚马逊后台填的单件成本乘以净销量，卖家没填的行写“官方未提供”，不当作 0。',
  '官方把广告扣款算到商品上；我方按广告商品报表归属并按规则分摊，两边的广告差额归“广告口径”；当天没有销售而没分摊出去的广告花费留在店铺级行，不在商品行里。',
]
const TRUNCATED_NOTE = '所选范围的数据行数超过读取上限，下面的核对不完整，请缩小日期范围'
const NO_COSTS_NOTE = '这个 SKU 还没有任何成本版本：到商品成本页录入采购单价，或由采购收货、头程分摊自动生成草稿，确认生效后利润才会计入成本。'

const target = ({ context, scope, product }: ProductAccess) => ({
  tenantId: context.tenantId,
  scope,
  sellerAccountId: product.sellerAccountId,
  storeName: product.sellerAccount.displayName,
  sku: product.sellerSku,
})

// ASIN 360“利润与成本”页签里的官方对照、费用预览与成本版本时间线（P2b-17）。三块各有自己的准入：
// 官方对照与官方核对页一致（finance.read + 利润与成本两个字段权限，缺任何一个 403）；费用预览只要 finance.read；成本时间线要 costs.read + 成本字段权限。
@Injectable()
export class ProductOfficialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
    private readonly sku: EconomicsSkuService,
    private readonly costs: CostsDetailService,
  ) {}

  async official(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now = new Date()): Promise<Asin360OfficialResponse> {
    const access = await this.access.resolve(req, id, ECONOMICS_READ)
    const { permissions } = access.context
    if (!(canSeeField(permissions, 'profit') && canSeeField(permissions, 'cost'))) {
      throw new AppError(403, 'TENANT_ACCESS_DENIED', '官方经济数据核对包含利润与成本，需要利润字段权限（field.profit）和成本字段权限（field.cost）')
    }
    const dates = ScopeSearchSchema.parse(rawQuery)
    const { recognition } = ProfitQuerySchema.parse({ recognition: rawQuery.recognition })
    const tenant = await this.prisma.tenant.findFirst({ where: { id: access.context.tenantId }, select: { timezone: true } })
    const periods = resolvePeriods(dates, todayIn(validZone(tenant?.timezone), now))
    const { period } = periods
    if (period.days > ECONOMICS_COMPARE_MAX_DAYS) throw new AppError(422, 'VALIDATION_FAILED', `官方对照一次最多看 ${ECONOMICS_COMPARE_MAX_DAYS} 天，请缩小日期范围`)
    const compared = await this.sku.compare(target(access), { basis: recognition, from: period.from, to: period.to, now })
    const empty = compared.coverage === null
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? NO_OFFICIAL_NOTE : null,
      recognition,
      basisLabel: PROFIT_BASIS_LABEL[recognition],
      currency: ECONOMICS_OURS_CURRENCY,
      range: { from: period.from, to: period.to, days: period.days, defaulted: periods.defaulted },
      summary: compared.summary,
      items: compared.rows,
      officialCoverage: compared.coverage,
      truncated: compared.truncated,
      notes: [PROFIT_BASIS_NOTE[recognition], ...OFFICIAL_NOTES, ...(compared.truncated ? [TRUNCATED_NOTE] : [])],
      freshness: compared.freshness,
    }
  }

  async preview(req: RequestWithContext, id: string, now = new Date()): Promise<Asin360PreviewResponse> {
    const access = await this.access.resolve(req, id, ECONOMICS_READ)
    return this.sku.preview(target(access), now)
  }

  async costVersions(req: RequestWithContext, id: string, now = new Date()): Promise<Asin360CostsResponse> {
    const access = await this.access.resolve(req, id, 'costs.read')
    if (!canSeeField(access.context.permissions, 'cost')) throw new AppError(403, 'TENANT_ACCESS_DENIED', '商品成本需要成本字段权限（field.cost）')
    const detail = await this.costs.detail(req, access.product.sellerSku, now)
    const empty = detail.versions.length === 0
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? NO_COSTS_NOTE : null,
      sku: detail.sku,
      today: detail.today,
      row: detail.row,
      versions: detail.versions,
      versionsTruncated: detail.versionsTruncated,
      notes: detail.notes,
    }
  }
}
