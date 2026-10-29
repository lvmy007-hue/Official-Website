import { Injectable } from '@nestjs/common'
import {
  ADS_READ,
  DAYPARTING_EXECUTION_PENDING,
  DAYPARTING_HISTORY_DAYS,
  DAYPARTING_SIM_ASSUMPTIONS,
  DAYPARTING_WRITE,
  ScopeSearchSchema,
  type DaypartingHeatmap,
  type DaypartingListResponse,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { validZone } from '../overview'
import { adsStreamSinkConfigured } from './ads-today.service'
import { levelOf, strategyRowOf, targetIdsOf, targetNames } from './ads-dayparting-common'
import { heatmapCells, loadProfiles, loadRuns, loadStrategies } from './ads-dayparting-load'
import type { AdsLoadContext } from './ads-overview-load'

const NOTE_STREAM_OFF = '营销数据流接收端尚未配置（没有设置 AMAZON_ADS_STREAM_SINK），没有小时级数据，热力图无法生成；配置并开始接收后才会出现，数据流不会补历史'
const NOTE_STREAM_EMPTY = `近 ${DAYPARTING_HISTORY_DAYS} 天没有活动级的小时指标（数据流只在配置之后才开始累积；小时维度的历史最多只有 ${DAYPARTING_HISTORY_DAYS} 天，亚马逊不提供更长的）`
const NOTE_NO_STRATEGY = '还没有创建分时策略；可以先看上面的热力图找出高峰与低谷时段，再新建策略'
const NOTE_NO_RUNS = '尚无记录：已启用的策略每小时执行一次，执行（包括跳过与失败）之后在这里显示'

// 分时策略页（P3-12，08 章 8.9）：热力图分析、策略列表（含此刻应执行的值）、执行记录。只读系统自己的数据与小时指标，不调亚马逊。
// 热力图只有数据流接收端配置之后才有数据（14.10 暂缓），历史最多 14 天；没有数据写“尚无记录”，没接入写“尚未接入”，不当 0。
@Injectable()
export class AdsDaypartingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now: Date = new Date()): Promise<DaypartingListResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    ScopeSearchSchema.parse(rawQuery)
    const tenantId = context.tenantId
    const ctx: AdsLoadContext = { tenantId, scope }
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const streamConnected = adsStreamSinkConfigured()

    const [cells, strategies, runs, profiles] = await Promise.all([
      streamConnected ? heatmapCells(this.prisma, ctx, zone, now) : Promise.resolve([]),
      loadStrategies(this.prisma, ctx),
      loadRuns(this.prisma, ctx),
      loadProfiles(this.prisma, ctx),
    ])
    const [names, people] = await Promise.all([
      targetNames(
        this.prisma,
        tenantId,
        (['CAMPAIGN', 'AD_GROUP'] as const).map(level => ({ level, ids: strategies.records.filter(record => levelOf(record.targetLevel) === level).flatMap(record => targetIdsOf(record.scopeJson)) })),
      ),
      memberNames(
        this.prisma,
        tenantId,
        strategies.records.map(record => record.updatedBy),
      ),
    ])
    const items = strategies.records.map(record => strategyRowOf(record, names, people, now))

    const heatmap: DaypartingHeatmap = {
      state: !streamConnected ? 'NOT_CONNECTED' : cells.length > 0 ? 'OK' : 'NO_DATA',
      note: !streamConnected ? NOTE_STREAM_OFF : cells.length > 0 ? null : NOTE_STREAM_EMPTY,
      zone,
      historyDays: DAYPARTING_HISTORY_DAYS,
      cells,
    }
    return {
      streamConnected,
      heatmap,
      strategies: { state: items.length > 0 ? 'OK' : 'NO_DATA', note: items.length > 0 ? null : NOTE_NO_STRATEGY, items, truncated: strategies.truncated },
      runs: { state: runs.length > 0 ? 'OK' : 'NO_DATA', note: runs.length > 0 ? null : NOTE_NO_RUNS, items: runs },
      profiles,
      canWrite: hasPermission(context.permissions as string[], DAYPARTING_WRITE),
      execution: DAYPARTING_EXECUTION_PENDING,
      assumptions: DAYPARTING_SIM_ASSUMPTIONS,
    }
  }
}
