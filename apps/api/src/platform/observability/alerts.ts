import { Inject, Injectable, Optional } from '@nestjs/common'
import { recordAlert } from './metrics'
import { logger as defaultLogger } from './logger'
import type { Logger } from 'pino'

// 站内告警接入点（P1-29，11 章 11.4）：业务代码统一调用 raise，不关心告警最终去哪里。
// 11.4 规定必须告警的情形都在 ALERT_CODES 里登记；新增告警类型必须先在这里登记。
// 告警的落库与站内通知由 P1-28 的“通知”能力注册为接收端（registerSink）；在此之前告警仍会写入日志并计入指标。

export const ALERT_CODES = ['SYNC_FAILED', 'AUTH_EXPIRING', 'WRITE_SWITCH_AUTO_CLOSED', 'FX_FETCH_FAILED', 'PUSH_INTERRUPTED', 'QUEUE_BACKLOG', 'SLOW_QUERY', 'DEFAULT_PARTITION_HAS_ROWS'] as const
export type AlertCode = (typeof ALERT_CODES)[number]
export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface AlertInput {
  code: AlertCode
  severity: AlertSeverity
  /** 面向运维或业务人员的说明，不得包含个人信息或令牌。 */
  message: string
  tenantId?: string
  /** 去重键：同一租户、同一代码、同一去重键在去重时间窗内只通知一次。 */
  dedupeKey: string
  /** 附加的非敏感上下文，值只能是简单类型。 */
  detail?: Record<string, string | number | boolean>
}

export interface AlertEvent extends AlertInput {
  occurredAt: Date
}

export interface AlertSink {
  deliver(event: AlertEvent): Promise<void>
}

export const ALERT_DEDUPE_WINDOW_MS = 10 * 60 * 1000

export const ALERT_OPTIONS = Symbol('ALERT_OPTIONS')
export interface AlertOptions {
  log?: Logger
  now?: () => number
  windowMs?: number
}

@Injectable()
export class AlertService {
  private readonly sinks: AlertSink[] = []
  private readonly lastSent = new Map<string, number>()
  private readonly log: Logger
  private readonly now: () => number
  private readonly windowMs: number

  constructor(@Optional() @Inject(ALERT_OPTIONS) options?: AlertOptions) {
    this.log = options?.log ?? defaultLogger
    this.now = options?.now ?? Date.now
    this.windowMs = options?.windowMs ?? ALERT_DEDUPE_WINDOW_MS
  }

  registerSink(sink: AlertSink) {
    this.sinks.push(sink)
  }

  /** 返回 true 表示本次实际发出；落在去重窗口内返回 false。 */
  async raise(input: AlertInput): Promise<boolean> {
    if (!ALERT_CODES.includes(input.code)) throw new Error(`unregistered alert code: ${input.code}`)
    const key = `${input.tenantId ?? '-'}|${input.code}|${input.dedupeKey}`
    const nowMs = this.now()
    const previous = this.lastSent.get(key)
    if (previous !== undefined && nowMs - previous < this.windowMs) return false
    this.lastSent.set(key, nowMs)
    this.prune(nowMs)

    const event: AlertEvent = { ...input, occurredAt: new Date(nowMs) }
    recordAlert(input.code, input.severity)
    const level = input.severity === 'critical' ? 'error' : input.severity === 'warning' ? 'warn' : 'info'
    this.log[level]({ event: 'alert', code: input.code, severity: input.severity, tenantId: input.tenantId, dedupeKey: input.dedupeKey, ...input.detail }, input.message)

    // 单个接收端失败不能影响业务，也不能影响其他接收端。
    for (const sink of this.sinks) {
      try {
        await sink.deliver(event)
      } catch (error) {
        this.log.error({ event: 'alert_sink_failed', code: input.code, error: error instanceof Error ? error.message : String(error) }, 'alert sink failed')
      }
    }
    return true
  }

  private prune(nowMs: number) {
    if (this.lastSent.size < 1000) return
    for (const [key, at] of this.lastSent) if (nowMs - at >= this.windowMs) this.lastSent.delete(key)
  }
}
