import { Injectable } from '@nestjs/common'
import { ADS_READ, DAYPARTING_HISTORY_DAYS, DAYPARTING_SIM_ASSUMPTIONS, DAYPARTING_SIM_MODEL, simulateGrid, type DaypartingSimulateResponse } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, ContextService } from '../auth'
import { validZone } from '../overview'
import { adsStreamSinkConfigured } from './ads-today.service'
import { findTargets, gridOfRecord, kindOf, levelOf, STRATEGY_ID_PATTERN, STRATEGY_SELECT, targetIdsOf } from './ads-dayparting-common'
import { strategyCells } from './ads-dayparting-load'

const NOTE_STREAM_OFF = '营销数据流接收端尚未配置，没有小时级历史，无法估算；配置并累积数据后才能模拟'
const NOTE_EMPTY = `这个策略的作用对象近 ${DAYPARTING_HISTORY_DAYS} 天没有小时指标（只统计美元账户；数据流只在配置之后累积），无法估算`
const NOTE_TARGETS_GONE = '这个策略的作用对象已经不存在或不在你的数据范围内，无法估算'

// 策略效果模拟（模型估算，不是亚马逊的预测）：把作用对象最近 14 天的小时指标按“星期 × 小时”累计，逐格套用策略取值。
// 只读，不写库、不调亚马逊；模型参数与假设原样随响应返回。
@Injectable()
export class AdsDaypartingSimulateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async simulate(req: RequestWithContext, id: string, now: Date = new Date()): Promise<DaypartingSimulateResponse> {
    // 权限先于一切：无权限的人先拿 403
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, {})
    if (!STRATEGY_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '分时策略不存在')
    const tenantId = context.tenantId
    const record = await this.prisma.daypartingStrategy.findFirst({ where: { id, tenantId, ...adsRelationWhere(scope) }, select: STRATEGY_SELECT })
    if (!record) throw appError('RESOURCE_NOT_FOUND', '分时策略不存在')
    const kind = kindOf(record.kind)
    const level = levelOf(record.targetLevel)
    const grid = gridOfRecord(record.hourlyMultipliersJson)
    const changedCells = grid.filter(value => value !== 1).length
    const base = { strategyId: record.id, historyDays: DAYPARTING_HISTORY_DAYS, model: DAYPARTING_SIM_MODEL, assumptions: DAYPARTING_SIM_ASSUMPTIONS }
    const empty = (state: DaypartingSimulateResponse['state'], note: string): DaypartingSimulateResponse => ({ ...base, state, note, coveredCells: 0, changedCells, baseline: null, estimated: null })
    if (!adsStreamSinkConfigured()) return empty('NOT_CONNECTED', NOTE_STREAM_OFF)

    // 作用对象可能已被同步删除：只用还在的对象；一个都不在就无法估算
    const wanted = targetIdsOf(record.scopeJson)
    const present = await findTargets(this.prisma, tenantId, scope, record.adsProfileId, level, wanted)
    if (present.length === 0) return empty('NO_DATA', NOTE_TARGETS_GONE)
    const cells = await strategyCells(
      this.prisma,
      { tenantId, scope },
      { adsProfileId: record.adsProfileId, level, externalIds: present.map(target => target.externalId), zone: validZone(record.timezone), now },
    )
    if (cells.length === 0) return empty('NO_DATA', NOTE_EMPTY)
    const outcome = simulateGrid(cells, kind, grid)
    return {
      ...base,
      state: 'OK',
      note: present.length < wanted.length ? `作用对象有 ${wanted.length - present.length} 个已经不存在，估算只包含还在的对象` : null,
      coveredCells: outcome.coveredCells,
      changedCells: outcome.changedCells,
      baseline: outcome.baseline,
      estimated: outcome.estimated,
    }
  }
}
