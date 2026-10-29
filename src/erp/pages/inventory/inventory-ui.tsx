import type { ReactNode } from 'react'
import { Alert, Tag, Typography } from 'antd'
import {
  INVENTORY_RISK_LABEL,
  INVENTORY_RISK_REASON_LABEL,
  REMOVAL_RECEIPT_STATE_LABEL,
  type DashState,
  type InventoryAssessment,
  type InventoryRiskLevel,
  type RemovalGuide,
  type RemovalReceiptState,
} from '@nova/api-contracts'
import { formatMoney, formatNumber } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useLivePages } from '../../routes/live-context'
import { specByComponent } from '../../routes/manifest'
import { safeHttpUrl } from '../../security/safe-url'

// 库存健康页与详情页共用的小件：风险标签、数据状态文案、尚未接入说明、到已上线页面的链接。

const RISK_COLOR: Record<InventoryRiskLevel, string> = { HIGH: 'error', MEDIUM: 'warning', NORMAL: 'success', EXCESS: 'processing' }

/** 风险等级标签；没有等级时说明原因（尚未配置规则、没有销量记录……），不显示任何默认等级。 */
export function RiskTag({ assessment }: { assessment: InventoryAssessment }) {
  if (assessment.risk) {
    return (
      <Tag color={RISK_COLOR[assessment.risk]} bordered={false}>
        {INVENTORY_RISK_LABEL[assessment.risk]}
      </Tag>
    )
  }
  const reason = assessment.reason ? INVENTORY_RISK_REASON_LABEL[assessment.reason] : '未判定'
  return <Typography.Text type="secondary">{assessment.state === 'NOT_CONNECTED' ? '尚未配置规则' : reason}</Typography.Text>
}

export const STATE_LABEL: Record<DashState, string> = { OK: '', NO_DATA: '尚无记录', NOT_CONNECTED: '尚未接入', RESTRICTED: '无权查看' }

/** 非“有数据”状态的整块说明：先说状态，再说原因。 */
export function StateBlock({ state, note, children }: { state: DashState; note?: string | null; children?: ReactNode }) {
  if (state === 'OK') return <>{children}</>
  return <Alert type={state === 'NOT_CONNECTED' ? 'info' : 'warning'} showIcon message={STATE_LABEL[state]} description={note ?? undefined} />
}

/** 页签里“尚未接入”的统一写法：说明原因与负责的工作包。 */
export function PendingPanel({ note, workPackage }: { note: string; workPackage: string }) {
  return <Alert type="info" showIcon message="尚未接入" description={`${note}（由 ${workPackage} 交付）`} />
}

/** 指向某个已上线页面的链接（路径里的 :参数 用 id 替换）；页面尚未上线时只显示文字，不给死链接。 */
export function LiveLink({ component, id, children }: { component: string; id: string; children: ReactNode }) {
  const pages = useLivePages()
  const spec = specByComponent.get(component)
  if (!spec || !(component in pages)) return <>{children}</>
  return <AppLink to={spec.path.replace(/:\w+/, encodeURIComponent(id))}>{children}</AppLink>
}

/** 空值显示的灰色文字。 */
export const Muted = ({ children }: { children: ReactNode }) => <Typography.Text type="secondary">{children}</Typography.Text>

// ---- 移除订单页面共用（P2a-09）：放在这里而不是单独成文件，是为了不多产生一个共享脚本块（首屏预算里按块名单计入）----

export const qty = (value: number | null | undefined) => (value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>)

export const fee = (value: number | null | undefined, currency: string | null | undefined) =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(value, currency || 'USD', { digits: 2 })}</span>

const RECEIPT_COLOR: Record<RemovalReceiptState, string> = { NOT_APPLICABLE: 'default', PENDING: 'processing', MATCHED: 'success', SHORT: 'error', OVER: 'warning' }

export function ReceiptStateTag({ state }: { state: RemovalReceiptState }) {
  return (
    <Tag color={RECEIPT_COLOR[state]} bordered={false}>
      {REMOVAL_RECEIPT_STATE_LABEL[state]}
    </Tag>
  )
}

/** 移除订单只能在亚马逊卖家后台创建：给出步骤与入口，不提供创建按钮。 */
export function GuideAlert({ guide }: { guide: RemovalGuide }) {
  return (
    <Alert
      type="info"
      showIcon
      style={{ margin: '8px 0' }}
      message={guide.title}
      description={
        <>
          <ol style={{ margin: '4px 0', paddingLeft: 20 }}>
            {guide.steps.map(step => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <Typography.Link href={safeHttpUrl(guide.url)} target="_blank" rel="noopener noreferrer">
            打开卖家后台
          </Typography.Link>
          <Typography.Text type="secondary"> （入口位置以亚马逊当前界面为准）</Typography.Text>
        </>
      }
    />
  )
}
