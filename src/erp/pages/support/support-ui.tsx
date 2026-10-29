import { Alert, Descriptions, Tag } from 'antd'
import { SUPPORT_ROLE_GUIDE, type SupportCaseRow, type SupportContactRow, type SupportLinkView, type SupportSync } from '@nova/api-contracts'
import { PiiField, type PiiFieldSpec } from '../../components'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'

// 支持案件页面共用的小件（P2b-04）：状态标签、同步状态提示、沟通时间线、赔付案件详情里“关联的支持案件”。
// 没有数据的写法：沟通条数还没同步写“尚未同步”、没有时间写“尚无记录”，任何时候都不拿 0 冒充。

const STATUS_COLOR: Record<string, string> = { PENDING_AMAZON_ACTION: 'processing', PENDING_MERCHANT_ACTION: 'warning', TRANSFERRED: 'default', RESOLVED: 'success' }

export function SupportStatusTag({ row }: { row: Pick<SupportCaseRow, 'status' | 'statusLabel'> }) {
  return (
    <Tag color={STATUS_COLOR[row.status] ?? 'default'} bordered={false}>
      {row.statusLabel}
    </Tag>
  )
}

export const contactCountText = (count: number | null) => (count === null ? <Muted>尚未同步</Muted> : <span className="erp-num">{count}</span>)

/** 同步状态提示：受限角色没批时给申请方式；同步失败时给原因；其余不打扰。 */
export function SyncNotice({ sync }: { sync: SupportSync }) {
  if (sync.rolePending) return <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="支持案件同步未授权" description={SUPPORT_ROLE_GUIDE} data-testid="support-role-pending" />
  if (sync.status === 'FAILED' || sync.status === 'UNAUTHORIZED' || sync.status === 'DELAYED') {
    return <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`支持案件同步：${sync.statusLabel}`} description={sync.errorMessage ?? undefined} />
  }
  return null
}

const DIRECTION_COLOR: Record<string, string> = { FROM_AMAZON: 'blue', FROM_SELLER: 'green', UNKNOWN: 'default' }

const BODY_FIELDS: readonly PiiFieldSpec[] = [{ name: 'body', label: '正文' }]

/** 沟通记录：从早到晚。正文是纯文本（不当 HTML 渲染）；其中的电话、邮箱、地址已由服务端掩码，原文经统一出口查看（P6-14）。 */
export function ContactTimeline({ contacts }: { contacts: SupportContactRow[] }) {
  return (
    <div data-testid="support-contacts">
      {contacts.map(contact => (
        <div key={contact.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
          <div>
            <Tag color={DIRECTION_COLOR[contact.direction]} bordered={false}>
              {contact.directionLabel}
            </Tag>
            <Tag bordered={false}>{contact.channelLabel}</Tag>
            <span className="erp-num">{formatDateTime(contact.occurredAt)}</span>
            {contact.senderName ? <span style={{ marginLeft: 8 }}>{contact.senderName}</span> : null}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
            {contact.piiKinds.length > 0 ? (
              <PiiField
                objectType="SUPPORT_CONTACT"
                objectId={contact.id}
                fields={BODY_FIELDS}
                layout="text"
                kinds={contact.piiKinds}
                maskedContent={contact.body}
                compact
                buttonLabel="查看原文"
                dialogTitle="查看沟通原文"
                reasonPlaceholder="例如：核对客户诉求"
              />
            ) : (
              contact.body || <Muted>（这条沟通没有文字内容）</Muted>
            )}
          </div>
          {contact.attachments.length ? <div style={{ marginTop: 4 }}>附件（仅名称，文件在卖家后台查看）：{contact.attachments.join('、')}</div> : null}
        </div>
      ))}
    </div>
  )
}

/** 赔付案件详情“概览”里的关联支持案件：五种状态都要说清楚。 */
export function SupportLinkInfo({ view }: { view: SupportLinkView }) {
  if (view.state !== 'OK')
    return (
      <Muted>
        {view.state === 'NOT_CONNECTED' ? '尚未接入：' : ''}
        {view.note}
      </Muted>
    )
  const row = view.case
  return (
    <div data-testid="support-link">
      <Descriptions size="small" column={1}>
        <Descriptions.Item label="案件">
          <AppLink to={`/app/support-cases/${encodeURIComponent(row.id)}`}>{row.caseId}</AppLink>（{row.subject}）
        </Descriptions.Item>
        <Descriptions.Item label="状态">
          <SupportStatusTag row={row} />
        </Descriptions.Item>
        <Descriptions.Item label="最近更新">{timeText(row.updatedAt)}</Descriptions.Item>
      </Descriptions>
      {view.contacts.length ? <ContactTimeline contacts={view.contacts} /> : <Muted>沟通记录尚未同步或暂无记录</Muted>}
    </div>
  )
}
