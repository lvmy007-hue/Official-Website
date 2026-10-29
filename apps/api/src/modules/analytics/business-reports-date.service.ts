import { Injectable } from '@nestjs/common'
import { BrDateQuerySchema, type BrDateResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { eachDay } from '../overview'
import { BusinessReportsAccessService } from './business-reports-access.service'
import { loadDailyRows } from './business-reports-load'
import { figuresOf, pointsOf, preferredRows, readFromOf } from './business-reports-math'

const COMPARE_ONLY_DAY = '对比期只支持按日：周与月的桶无法与对比期逐个对齐，已忽略对比期。'

// 按日期（P4-02，04 章 4.5 第 2、6 个页签）：按日、周、月的逐期指标与范围合计。
// 日粒度逐日补齐（没有记录的日子各项为空，图上断开，不画成 0）并支持对比期并排；周与月粒度读官方周、月行（周日起、月第一天），只列有记录的期间。
@Injectable()
export class BusinessReportsDateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessReportsAccessService,
  ) {}

  async byDate(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<BrDateResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const { granularity } = BrDateQuerySchema.parse({ granularity: rawQuery.granularity })
    const range = this.access.rangeOf(access, granularity)
    const daily = granularity === 'DAY'
    const compare = daily ? access.periods.compare : null
    const [current, previous] = await Promise.all([
      loadDailyRows(this.prisma, access.tenantId, access.scope, granularity, readFromOf(granularity, range.from), range.to),
      compare ? loadDailyRows(this.prisma, access.tenantId, access.scope, 'DAY', compare.from, compare.to) : Promise.resolve(null),
    ])
    const rows = preferredRows(current.rows)
    const points = pointsOf(rows, daily ? eachDay(range.from, range.to) : undefined)
    const withData = points.filter(point => point.source !== null)
    const header = await this.access.header(
      access,
      { range, hasData: withData.length > 0, truncated: current.truncated || (previous?.truncated ?? false), latestDate: withData.length > 0 ? withData[withData.length - 1]!.date : null },
      now,
    )
    return {
      ...header,
      granularity,
      compare,
      compareNote: !daily && access.scopeQuery.compare !== 'none' ? COMPARE_ONLY_DAY : null,
      points,
      comparePoints: compare && previous ? pointsOf(preferredRows(previous.rows), eachDay(compare.from, compare.to)) : null,
      totals: figuresOf(rows),
    }
  }
}
