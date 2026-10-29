import { runWithTenant } from '@nova/tenancy'
import type { AlertCode, AlertEvent, AlertSink } from '../../platform/observability'
import { NotifyService, type NotificationSeverity } from './notify.service'

// 站内告警的落地接收端（P1-29 预留、P1-28 注册）：告警带企业编号时，通知该企业有“预警管理”权限的成员（所有者与管理员）。
// 不带企业编号的平台级告警只写日志与指标，不进入任何企业的消息中心。

const TITLE: Record<AlertCode, string> = {
  SYNC_FAILED: '数据同步失败',
  AUTH_EXPIRING: '亚马逊授权即将失效',
  WRITE_SWITCH_AUTO_CLOSED: '写入开关已被自动关闭',
  FX_FETCH_FAILED: '汇率获取失败',
  PUSH_INTERRUPTED: '亚马逊推送中断',
  QUEUE_BACKLOG: '后台任务积压',
  SLOW_QUERY: '查询过慢',
  DEFAULT_PARTITION_HAS_ROWS: '数据分区需要处理',
}

const LINK: Partial<Record<AlertCode, string>> = {
  SYNC_FAILED: '/app/sync',
  AUTH_EXPIRING: '/app/connections',
  WRITE_SWITCH_AUTO_CLOSED: '/app/settings/integrations',
  FX_FETCH_FAILED: '/app/settings/fx',
  PUSH_INTERRUPTED: '/app/connections/notifications',
}

const SEVERITY: Record<AlertEvent['severity'], NotificationSeverity> = { info: 'INFO', warning: 'WARNING', critical: 'CRITICAL' }

export class AlertNotificationSink implements AlertSink {
  constructor(private readonly notify: NotifyService) {}

  async deliver(event: AlertEvent): Promise<void> {
    if (!event.tenantId) return
    const day = event.occurredAt.toISOString().slice(0, 10)
    await runWithTenant(event.tenantId, () =>
      this.notify.toHolders(event.tenantId as string, 'alerts.manage', {
        kind: `ALERT_${event.code}`,
        title: TITLE[event.code],
        body: event.message,
        link: LINK[event.code],
        severity: SEVERITY[event.severity],
        // 同一天同一问题只通知一次
        dedupKey: `alert:${event.code}:${event.dedupeKey}:${day}`,
      }),
    )
  }
}
