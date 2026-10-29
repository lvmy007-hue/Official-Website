import { useEffect, useState, type ReactNode } from 'react'
import { Tag, Typography } from 'antd'
import {
  INBOUND_OP_LABEL,
  INBOUND_OP_STATUS_LABEL,
  INBOUND_STAGE_LABEL,
  INBOUND_WRITE,
  OPPORTUNITY_STATUS_LABEL,
  type ClaimListState,
  type InboundOp,
  type InboundOpStatus,
  type InboundPlanListResponse,
  type InboundPlanRow,
  type InboundStage,
  type InboundWriteStatus,
} from '@nova/api-contracts'
import type { FreshnessInfo, GuardInput } from '../../components'
import { formatDateTime, formatMoney, formatNumber } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 入仓计划页面共用的小件：阶段与操作状态标签、截止时间倒计时、金额与数量显示（没有数据写“尚无记录”，不写 0）、动作守卫。

export const INBOUND_WRITE_PERMISSION = INBOUND_WRITE

export const qty = (value: number | null | undefined): ReactNode =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>
export const money = (value: number | null | undefined, currency = 'USD'): ReactNode =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(value, currency)}</span>

const STAGE_COLOR: Record<InboundStage, string> = {
  DRAFT: 'default',
  ELIGIBILITY: 'default',
  CREATED: 'processing',
  PACKING_CONFIRMED: 'processing',
  PACKING_INFO_SUBMITTED: 'processing',
  PLACEMENT_CONFIRMED: 'processing',
  TRANSPORT_CONFIRMED: 'cyan',
  LABELS_PRINTED: 'cyan',
  SHIPPED: 'blue',
  RECEIVING: 'blue',
  DISCREPANCY: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'default',
}

/** 阶段标签；有操作在途时同时显示“处理中：某某操作”，提醒这一行的状态还没有定下来。 */
export function StageTag({ plan }: { plan: Pick<InboundPlanRow, 'stage' | 'pendingOp'> }) {
  return (
    <>
      <Tag color={STAGE_COLOR[plan.stage]} bordered={false}>
        {INBOUND_STAGE_LABEL[plan.stage]}
      </Tag>
      {plan.pendingOp ? (
        <Tag color="gold" bordered={false} title="操作已交给后台任务，等亚马逊返回结果">
          处理中：{INBOUND_OP_LABEL[plan.pendingOp]}
        </Tag>
      ) : null}
    </>
  )
}

const OP_COLOR: Record<InboundOpStatus, string> = { QUEUED: 'default', IN_PROGRESS: 'processing', SUCCESS: 'success', FAILED: 'error', TIMEOUT: 'warning' }
export const OpStatusTag = ({ status }: { status: InboundOpStatus }) => (
  <Tag color={OP_COLOR[status]} bordered={false}>
    {INBOUND_OP_STATUS_LABEL[status]}
  </Tag>
)
export const opLabel = (operation: InboundOp) => INBOUND_OP_LABEL[operation]

export const DEADLINE_LABEL = { PACKING_EXPIRES: '装箱方案有效期', PLACEMENT_EXPIRES: '分仓方案有效期', VOID_WINDOW: '作废窗口' } as const

/** 每秒刷新的当前时间，倒计时用。 */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export function remainingText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
}

/** 截止时间倒计时：剩余不足一小时标红提醒；已过显示“已过期”；没有截止信息显示“尚无记录”。 */
export function Countdown({ at, expiredText = '已过期' }: { at: string | null | undefined; expiredText?: string }) {
  const now = useNow()
  if (!at) return <Muted>尚无记录</Muted>
  const left = new Date(at).getTime() - now
  if (left <= 0) return <Typography.Text type="danger">{expiredText}</Typography.Text>
  return (
    <Typography.Text type={left < 3_600_000 ? 'danger' : undefined} className="erp-num" data-testid="countdown">
      剩余 {remainingText(left)}
    </Typography.Text>
  )
}

/** 动作守卫：权限始终要有；调用亚马逊的动作再带上连接与写入开关环节（服务端按“权限 → 连接 → 开关”算出，写明卡在哪一步）。 */
export function inboundGuard(write: InboundWriteStatus | undefined, options: { amazon: boolean; condition?: { ok: boolean; reason?: string } }): GuardInput {
  const blocked = options.amazon && write && !write.allowed ? write : null
  const fix = blocked?.remedyPath ? { label: blocked.step === 'SWITCH' ? '前往开启' : '前往连接中心', href: blocked.remedyPath } : undefined
  return {
    permission: INBOUND_WRITE_PERMISSION,
    ...(blocked?.step === 'CONNECTION' ? { connection: { ok: false, reason: blocked.reason ?? undefined, fix } } : {}),
    ...(blocked?.step === 'SWITCH' ? { writeSwitch: { enabled: false, fix } } : {}),
    ...(options.condition ? { condition: options.condition } : {}),
  }
}

export function inboundFreshnessInfo(freshness: InboundPlanListResponse['freshness'] | undefined): FreshnessInfo | null {
  if (!freshness) return null
  const attention = freshness.status === 'NORMAL' || freshness.status === 'NOT_APPLICABLE' || freshness.status === 'NO_RECORD' ? 0 : 1
  return { lastSuccessAt: freshness.lastSuccessAt, sources: freshness.lastSuccessAt ? ['入仓计划与货件（亚马逊入库接口）'] : [], qualityIssues: attention }
}

export const SOURCE_LABEL: Record<string, string> = { MANUAL: '手工', REPLENISHMENT: '补货批次', REPLENISHMENT_BATCH: '补货批次', PURCHASE_ORDER: '采购单' }

// ---- 货件接收与差异（P2a-13）两个页面与入仓计划详情的“接收与差异”页签共用；放在这里而不是单独成文件，避免多产生一个共享脚本块 ----

const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  WORKING: '创建中',
  READY_TO_SHIP: '待发货',
  SHIPPED: '已发出',
  IN_TRANSIT: '运输中',
  DELIVERED: '已送达',
  CHECKED_IN: '已到仓登记',
  RECEIVING: '接收中',
  CLOSED: '已关闭',
  CANCELLED: '已取消',
  DELETED: '已删除',
  ERROR: '异常',
}
export const shipmentStatusText = (status: string) => SHIPMENT_STATUS_LABEL[status] ?? status

const CLAIM_LABEL: Record<ClaimListState, string> = { NOT_JUDGED: '货件未关闭，暂不判断', NONE: '无需赔付', WAITING: '等待期内', ...OPPORTUNITY_STATUS_LABEL }
const CLAIM_COLOR: Record<ClaimListState, string> = {
  NOT_JUDGED: 'default',
  NONE: 'default',
  WAITING: 'processing',
  PENDING: 'warning',
  CASE_CREATED: 'blue',
  IGNORED: 'default',
  EXPIRED: 'error',
  RESOLVED: 'success',
}
export const ClaimTag = ({ state }: { state: ClaimListState }) => (
  <Tag color={CLAIM_COLOR[state]} bordered={false}>
    {CLAIM_LABEL[state]}
  </Tag>
)

/** 不合规问题数：不合规报告还没有同步成功过时是“尚未接入”，不是 0。 */
export const noncomplianceText = (count: number | null): ReactNode => (count === null ? <Muted>尚未接入</Muted> : <span className="erp-num">{formatNumber(count, { digits: 0 })}</span>)

/** 差异数量带方向：应发多于已收是少收，反之是多收。 */
export const diffText = (value: number | null | undefined): ReactNode =>
  value === null || value === undefined ? (
    <Muted>尚无记录</Muted>
  ) : (
    <span className="erp-num">{value === 0 ? '无差异' : value > 0 ? `少收 ${formatNumber(value, { digits: 0 })}` : `多收 ${formatNumber(-value, { digits: 0 })}`}</span>
  )

export const dayCount = (value: number | null): ReactNode => (value === null ? <Muted>无</Muted> : <span className="erp-num">{value} 天</span>)

export const timeText = (value: string | null): ReactNode => (value ? formatDateTime(value) : <Muted>尚无记录</Muted>)
