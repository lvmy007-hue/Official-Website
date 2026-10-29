import type { ReactNode } from 'react'
import { Alert, Tag, Typography } from 'antd'
import { AWD_PENDING_LABEL, type AwdFreshness, type AwdOrderRow, type AwdWriteStatus } from '@nova/api-contracts'
import type { FreshnessInfo, GuardInput } from '../../components'
import { formatNumber } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 上游仓储页面共用的小件：数量显示（没有数字显示“尚无记录”，不写 0）、写入守卫、数据状态说明。

export const AWD_WRITE = 'awd.order.write'

export const qty = (value: number | null | undefined): ReactNode =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>

const ORDER_COLOR: Record<string, string> = {
  LOCAL_DRAFT: 'default',
  CREATE_FAILED: 'error',
  DRAFT: 'processing',
  VALIDATING: 'processing',
  CONFIRMED: 'success',
  CLOSED: 'default',
  EXPIRED: 'warning',
  CANCELLED: 'default',
}

/** 订单状态标签；有后台操作在途时同时显示“处理中”，提醒这一行的状态还没有定下来。 */
export function OrderStatusTag({ order }: { order: Pick<AwdOrderRow, 'status' | 'statusLabel' | 'pendingAction'> }) {
  return (
    <>
      <Tag color={ORDER_COLOR[order.status] ?? 'default'} bordered={false}>
        {order.statusLabel}
      </Tag>
      {order.pendingAction ? (
        <Tag color="gold" bordered={false} title="操作已交给后台任务，结果以订单状态为准">
          {AWD_PENDING_LABEL[order.pendingAction]}
        </Tag>
      ) : null}
    </>
  )
}

/** 新鲜度条要显示的内容：只有真正同步成功过才列出来源；同步异常或延迟记为一条质量提示。 */
export function awdFreshnessInfo(freshness: AwdFreshness | null | undefined): FreshnessInfo | null {
  if (!freshness) return null
  const attention = freshness.status === 'NORMAL' || freshness.status === 'NOT_APPLICABLE' || freshness.status === 'NO_RECORD' ? 0 : 1
  return { lastSuccessAt: freshness.lastSuccessAt, sources: freshness.lastSuccessAt ? ['亚马逊仓储分销（AWD）'] : [], qualityIssues: attention }
}

/**
 * 动作守卫：服务端给出“权限 → 连接 → 写入开关”哪一步没通过。
 * 调用亚马逊的动作用 withAmazon（带连接与开关环节）；只改本地数据的动作（保存草稿、取消本地草稿）只要权限。
 */
export function awdGuard(write: AwdWriteStatus | undefined, options: { amazon: boolean; condition?: { ok: boolean; reason?: string } }): GuardInput {
  const blocked = options.amazon && write && !write.allowed ? write : null
  const fix = blocked?.remedyPath ? { label: blocked.step === 'SWITCH' ? '前往开启' : '前往连接中心', href: blocked.remedyPath } : undefined
  return {
    permission: AWD_WRITE,
    ...(blocked?.step === 'CONNECTION' ? { connection: { ok: false, reason: blocked.reason ?? undefined, fix } } : {}),
    ...(blocked?.step === 'SWITCH' ? { writeSwitch: { enabled: false, fix } } : {}),
    ...(options.condition ? { condition: options.condition } : {}),
  }
}

/** 列表页的整体状态说明：未同步、没有开通、暂无记录。 */
export function StateNote({ state, note }: { state: string; note: string | null }) {
  if (state === 'OK') return null
  return (
    <Alert
      type={state === 'NOT_CONNECTED' ? 'info' : 'warning'}
      showIcon
      style={{ margin: '8px 0' }}
      message={state === 'NOT_APPLICABLE' ? '未开通亚马逊仓储分销' : state === 'NO_DATA' ? '尚无记录' : '尚未同步'}
      description={note ?? undefined}
    />
  )
}

export const MutedText = ({ children }: { children: ReactNode }) => <Typography.Text type="secondary">{children}</Typography.Text>
