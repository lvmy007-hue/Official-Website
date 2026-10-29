import { Injectable } from '@nestjs/common'
import {
  ECONOMICS_COMPARE_FRESHNESS_KEYS,
  ECONOMICS_OURS_CURRENCY,
  EconomicsCompareQuerySchema,
  PROFIT_BASIS_LABEL,
  PROFIT_BASIS_NOTE,
  ScopeSearchSchema,
  adsStoreCheck,
  compareDays,
  summarizeCompare,
  type ComparedRow,
  type CompareFilter,
  type EconomicsCompareQuery,
  type EconomicsCompareResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { sourceFreshness } from '../inventory'
import { EconomicsAccessService } from './economics-access.service'
import { loadCompare } from './economics-load'
import { compareText, decodeOffset, pageOf } from './economics-page'

const NO_DATA_NOTE =
  '官方经济数据尚无记录：店铺授权卖家账号并开通“卖家洞察”角色后，亚马逊数据中心的官方单品经济每天同步一次（第一次回补最近 90 天）；没有同步到数据之前，下面没有可核对的行，不会显示成 0'
const COST_NOTE = '成本口径只在官方与我方都有成本时核对：官方成本是卖家在亚马逊后台填的单件成本乘以净销量，卖家没填的行写“官方未提供”，不当作 0。'
const ADS_NOTE = '官方把广告扣款算到商品上；我方按广告商品报表归属并按规则分摊，两边的广告差额归“广告口径”；没分摊出去的花费留在店铺级行，只在下面的店铺层面广告核对里出现。'
const TRUNCATED_NOTE = '所选范围的数据行数超过读取上限，下面的核对不完整（超出上限的商品没有读到），请缩小日期范围或选择单个店铺'

const isDiff = (row: ComparedRow) => row.verdict !== 'MATCH' && row.verdict !== 'NOT_COMPARABLE'
const FILTERS: Record<CompareFilter, (row: ComparedRow) => boolean> = {
  ALL: () => true,
  DIFF: isDiff,
  MATCH: row => row.verdict === 'MATCH',
  NOT_COMPARABLE: row => row.verdict === 'NOT_COMPARABLE',
  COST: row => row.verdict === 'COST',
  ADS: row => row.verdict === 'ADS',
  TIME: row => row.verdict === 'TIME',
  UNEXPLAINED: row => row.verdict === 'UNEXPLAINED',
}

/** 排序：差异绝对值（无法核对的排最后，不管升降序）或日期；同值按店铺、SKU、日期稳定排序。 */
function sortRows(rows: ComparedRow[], sort: EconomicsCompareQuery['sort']): ComparedRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  const tie = (a: ComparedRow, b: ComparedRow) => compareText(a.key, b.key)
  return [...rows].sort((a, b) => {
    if (sort.field === 'date') return a.date === b.date ? tie(a, b) : compareText(a.date, b.date) * sign
    const left = a.impact === null ? null : Math.abs(a.impact.net)
    const right = b.impact === null ? null : Math.abs(b.impact.net)
    if (left === null || right === null) return left === right ? tie(a, b) : left === null ? 1 : -1
    return left === right ? tie(a, b) : (left - right) * sign
  })
}

// 双源核对（07 章 7.10 第 1 个页签）：官方单品经济（数据中心）与我方利润日表逐 SKU 逐日核对，差异拆成成本口径、广告口径、时间口径、未解释。
// 我方取哪种收入确认口径由请求决定；官方一天都没有记录的 SKU 不当作“全部差异”，写成无法核对。
@Injectable()
export class EconomicsCompareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EconomicsAccessService,
  ) {}

  async compare(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<EconomicsCompareResponse> {
    const access = await this.access.resolve(req, rawQuery, { fields: true, now })
    const query = EconomicsCompareQuerySchema.parse({
      recognition: rawQuery.recognition,
      verdict: rawQuery.verdict,
      q: rawQuery.q,
      sort: rawQuery.sort,
      cursor: rawQuery.cursor,
      pageSize: rawQuery.pageSize,
    })
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), ...query })
    const offset = decodeOffset(query.cursor, binding)
    const { tenantId, scope, range } = access
    const [loaded, stores, freshness] = await Promise.all([
      loadCompare(this.prisma, { tenantId, scope, basis: query.recognition, from: range.from, to: range.to }),
      this.prisma.sellerAccount.findMany({ where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) }, select: { id: true, displayName: true }, take: 500 }),
      sourceFreshness(this.prisma, tenantId, scope, ECONOMICS_COMPARE_FRESHNESS_KEYS, now),
    ])
    const names = new Map(stores.map(store => [store.id, store.displayName]))
    const keyword = query.q?.toLowerCase()
    const all = compareDays(loaded.candidates, { withCost: true })
    const filtered = sortRows(
      all.filter(row => FILTERS[query.verdict](row) && (!keyword || row.msku.toLowerCase().includes(keyword) || (row.asin ?? '').toLowerCase().includes(keyword))),
      query.sort,
    )
    const { page, pageInfo } = pageOf(filtered, offset, query.pageSize, binding)
    const summary = { ...summarizeCompare(filtered), ads: adsStoreCheck({ officialRows: loaded.officialRows, official: loaded.officialAds, oursRows: loaded.oursAdsRows, ours: loaded.oursAds }) }
    const noData = loaded.coverage === null // 官方一行都没有（覆盖范围为空）
    return {
      state: noData ? 'NO_DATA' : 'OK',
      note: noData ? NO_DATA_NOTE : null,
      recognition: query.recognition,
      basisLabel: PROFIT_BASIS_LABEL[query.recognition],
      currency: ECONOMICS_OURS_CURRENCY,
      range,
      summary,
      items: page.map(row => ({ ...row, storeName: names.get(row.sellerAccountId) ?? row.sellerAccountId })),
      pageInfo,
      officialCoverage: loaded.coverage,
      truncated: loaded.truncated,
      notes: [PROFIT_BASIS_NOTE[query.recognition], COST_NOTE, ADS_NOTE, ...(loaded.truncated ? [TRUNCATED_NOTE] : [])],
      freshness,
    }
  }
}
