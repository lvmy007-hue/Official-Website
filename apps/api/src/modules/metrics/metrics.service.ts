import { Injectable } from '@nestjs/common'
import { MetricSearchQuerySchema, METRIC_TYPES, customMetricDefinition, metricGroups, searchMetrics } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'

// 指标口径（P1-28-8，09 章 9.5）：数据来自冻结的指标字典，并合并本企业的自定义指标（P6-32，类型为“自定义”）。
@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async definitions(tenantId: string, rawQuery: Record<string, string>) {
    const parsed = MetricSearchQuerySchema.parse(rawQuery)
    const rows = await this.prisma.customMetric.findMany({ where: { tenantId }, orderBy: { key: 'asc' }, take: 100 })
    const extra = rows.map(row => customMetricDefinition(row))
    const { items, total } = searchMetrics(parsed, extra)
    return { items: items.map(item => ({ ...item, history: [] as never[] })), total, page: parsed.page, pageSize: parsed.pageSize, groups: metricGroups(extra), types: [...METRIC_TYPES] }
  }
}
