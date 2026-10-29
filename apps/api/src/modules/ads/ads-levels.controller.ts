import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ADS_COUNTS_STRIPPED_KEYS, isAdsLevel, type AdsLevel } from '@nova/api-contracts'
import { appError, ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AdTermsService } from './ad-terms.service'
import { AdsCampaignListService } from './ads-campaigns-list.service'
import { AdsGroupListService } from './ads-groups-list.service'
import { AdsAsinListService } from './ads-products.service'

// 广告层级页（P6-23，freeze/api.md GET /ads/ad-groups、GET /ads/:level/counts）：广告组列表与五个层级共用的分类计数。
// 只读（ads.read 与数据范围）。计数接口的 level 是白名单，其余 404；筛选参数与对应列表接口相同，只是不带分页、排序与分类（分类就是被数的对象）。
// 注册顺序：这个控制器必须排在活动、广告组、投放的控制器之前，否则 /ads/campaigns/counts 会被当成 :id。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsLevelsController {
  constructor(
    private readonly campaigns: AdsCampaignListService,
    private readonly groups: AdsGroupListService,
    private readonly terms: AdTermsService,
    private readonly products: AdsAsinListService,
  ) {}

  @Get('ad-groups')
  async adGroups(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.groups.list(req, query), req)
  }

  @Get(':level/counts')
  async counts(@Req() req: RequestWithContext, @Param('level') level: string, @Query() query: Record<string, string>) {
    if (!isAdsLevel(level)) throw appError('RESOURCE_NOT_FOUND', '没有这个广告层级')
    const filters = Object.fromEntries(Object.entries(query).filter(([key]) => !(ADS_COUNTS_STRIPPED_KEYS as readonly string[]).includes(key)))
    return ok(await this.countsOf(req, level, filters), req)
  }

  private countsOf(req: RequestWithContext, level: AdsLevel, filters: Record<string, string>) {
    switch (level) {
      case 'campaigns':
        return this.campaigns.counts(req, filters)
      case 'ad-groups':
        return this.groups.counts(req, filters)
      case 'products':
        return this.products.counts(req, filters)
      case 'targets':
      case 'search-terms':
        return this.terms.counts(req, filters, level)
    }
  }
}
