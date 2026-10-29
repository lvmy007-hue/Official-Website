import { Injectable } from '@nestjs/common'
import { normalizeRouteTemplate, WebVitalsReportSchema } from '@nova/api-contracts'
import { recordWebVital } from '../../platform/observability'

@Injectable()
export class TelemetryService {
  /** 校验并记录一批前端性能指标；路由模板再归一一次，防止具体编号进入指标标签。返回接收条数。 */
  report(body: unknown): number {
    const { items } = WebVitalsReportSchema.parse(body)
    for (const item of items) recordWebVital(item.name, item.valueMs, normalizeRouteTemplate(item.route))
    return items.length
  }
}
