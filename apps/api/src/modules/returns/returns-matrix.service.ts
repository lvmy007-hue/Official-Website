import { Injectable } from '@nestjs/common'
import {
  RETURN_ANALYSIS_BASIS,
  RETURN_DISPOSITION_GROUPS,
  RETURN_DISPOSITION_LABEL,
  returnDispositionView,
  type ReturnDispositionGroup,
  type ReturnDispositionMatrixResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ReturnsAnalysisContextService } from './returns-analysis-context'

const STATUS_COLUMNS = 8
const GROUP_CAP = 500
const NONE_KEY = '__NONE__'
const OTHER_KEY = '__OTHER__'

// 库存属性 × 处置结果（P6-13）：行是退货件的处置分组（可售、损坏…），列是报告里的处理状态原文（最多 8 种，其余并入“其他状态”）。
// 数据库按两列分组汇总，不读明细，件数精确。只展示有数据的行。
@Injectable()
export class ReturnsMatrixService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ReturnsAnalysisContextService,
  ) {}

  async matrix(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ReturnDispositionMatrixResponse> {
    const a = await this.ctx.open(req, rawQuery, 'basis')
    const [groups, unknown, freshness] = await Promise.all([
      this.prisma.fbaReturnCase.groupBy({ by: ['disposition', 'reportStatus'], where: a.where, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: GROUP_CAP }),
      this.ctx.unknown(a.unknownWhere),
      this.ctx.freshness(a.tenantId, a.scope),
    ])
    const cells = new Map<string, number>()
    const statusUnits = new Map<string, number>()
    let total = 0
    for (const group of groups) {
      const units = group._sum.quantity ?? 0
      const status = group.reportStatus?.trim() || NONE_KEY
      const key = `${returnDispositionView(null, group.disposition).group}|${status}`
      cells.set(key, (cells.get(key) ?? 0) + units)
      statusUnits.set(status, (statusUnits.get(status) ?? 0) + units)
      total += units
    }
    const ranked = [...statusUnits.entries()].filter(([status]) => status !== NONE_KEY).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    const shown = ranked.slice(0, STATUS_COLUMNS).map(([status]) => status)
    const hasOther = ranked.length > STATUS_COLUMNS
    const columns = [
      ...shown.map(status => ({ key: status, label: status })),
      ...(hasOther ? [{ key: OTHER_KEY, label: '其他状态' }] : []),
      ...(statusUnits.has(NONE_KEY) ? [{ key: NONE_KEY, label: '未提供' }] : []),
    ]
    const columnOf = (status: string) => (status === NONE_KEY ? NONE_KEY : shown.includes(status) ? status : OTHER_KEY)
    const present = new Set<ReturnDispositionGroup>()
    for (const key of cells.keys()) present.add(key.split('|')[0] as ReturnDispositionGroup)
    const rows = RETURN_DISPOSITION_GROUPS.filter(group => present.has(group)).map(group => ({ key: group, group, label: RETURN_DISPOSITION_LABEL[group] }))
    const grid = rows.map(() => columns.map(() => 0))
    for (const [key, units] of cells) {
      const [group, ...rest] = key.split('|')
      const status = rest.join('|')
      const r = rows.findIndex(row => row.key === group)
      const c = columns.findIndex(column => column.key === columnOf(status))
      grid[r]![c] = (grid[r]![c] ?? 0) + units
    }
    const empty = total === 0
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? '所选日期范围内尚无退货记录；店铺授权并完成客户退货报告同步后显示（报告每天同步一次）' : null,
      range: { from: a.from, to: a.to, defaulted: a.defaulted },
      timeBasis: a.timeBasis,
      unknownOrderUnits: unknown.units,
      unknownOrderRows: unknown.rows,
      basis: RETURN_ANALYSIS_BASIS.matrix,
      freshness,
      rows,
      columns,
      cells: grid,
      totals: { units: total },
    }
  }
}
