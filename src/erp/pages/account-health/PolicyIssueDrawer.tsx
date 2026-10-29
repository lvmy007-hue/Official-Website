import { Alert, Descriptions, Drawer, Form, Input, Select, Space, Timeline } from 'antd'
import { ACCOUNT_HEALTH_HANDLE, POLICY_HANDLING_STATUSES, POLICY_HANDLING_STATUS_LABEL, type PolicyIssueDetail, type PolicyIssueRow } from '@nova/api-contracts'
import { DataState, FormAction, stateFromError } from '../../components'
import { formatDateTime } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { HandlingTag, IssueStatusTag } from './account-health-ui'

// 政策合规问题详情抽屉（P5-02，09 章 9.2）：问题本身、处理记录、关联的亚马逊支持案件、处理表单。
// 处理只改本系统里的负责人、处理状态、备注与关联案件编号，不会调用亚马逊，也不会把问题标为“已解决”（解决状态只由每日报告决定）。

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const timeOf = (value: string | null) => (value ? <span className="erp-num">{formatDateTime(value)}</span> : <Muted>尚无记录</Muted>)

function HandleAction({ detail, onDone }: { detail: PolicyIssueDetail; onDone: () => void }) {
  const issue = detail.issue
  const update = useApiMutation<Record<string, unknown>, PolicyIssueRow>({ method: 'PATCH', path: `/account-health/issues/${encodeURIComponent(issue.id)}`, invalidate: ['list'], silent: true })
  return (
    <FormAction
      label="处理"
      buttonProps={{ type: 'primary' }}
      guard={{ permission: ACCOUNT_HEALTH_HANDLE }}
      title="处理这条政策合规问题"
      description="这里只记录你们内部的处理信息，不会提交到亚马逊；问题是否解决以每日同步的账户健康报告为准。"
      okText="保存"
      successText="已保存"
      onDone={onDone}
      initialValues={{ ownerUserId: issue.owner?.id, handlingStatus: issue.handlingStatus, handlingNote: issue.handlingNote ?? '', amazonCaseId: issue.amazonCaseId ?? '' }}
      onSubmit={values =>
        update.mutateAsync({
          version: issue.version,
          ownerUserId: typeof values.ownerUserId === 'string' && values.ownerUserId ? values.ownerUserId : null,
          handlingStatus: values.handlingStatus,
          handlingNote: text(values.handlingNote),
          amazonCaseId: text(values.amazonCaseId),
        })
      }
    >
      <Form.Item label="负责人" name="ownerUserId">
        <Select
          aria-label="负责人"
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="未指定"
          style={{ width: 260 }}
          options={detail.owners.map(item => ({ value: item.id, label: item.name }))}
        />
      </Form.Item>
      <Form.Item label="处理状态" name="handlingStatus">
        <Select aria-label="处理状态" style={{ width: 200 }} options={POLICY_HANDLING_STATUSES.map(value => ({ value, label: POLICY_HANDLING_STATUS_LABEL[value] }))} />
      </Form.Item>
      <Form.Item label="处理备注" name="handlingNote">
        <Input.TextArea aria-label="处理备注" rows={3} maxLength={500} showCount />
      </Form.Item>
      <Form.Item label="亚马逊案件编号（在卖家后台提交申诉后填写，用来关联支持案件）" name="amazonCaseId">
        <Input aria-label="亚马逊案件编号" maxLength={64} />
      </Form.Item>
    </FormAction>
  )
}

function Body({ detail, onChanged }: { detail: PolicyIssueDetail; onChanged: () => void }) {
  const { issue, support, timeline } = detail
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Descriptions size="small" column={1} bordered data-testid="issue-descriptions">
        <Descriptions.Item label="问题">{issue.title}</Descriptions.Item>
        <Descriptions.Item label="类型">{issue.kindLabel}</Descriptions.Item>
        <Descriptions.Item label="店铺">{issue.storeName}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <IssueStatusTag status={issue.status} label={issue.statusLabel} />
          {issue.resolvedAt ? <span style={{ marginLeft: 8 }}>解决于 {formatDateTime(issue.resolvedAt)}</span> : null}
        </Descriptions.Item>
        <Descriptions.Item label="首次出现">{timeOf(issue.firstSeenAt)}</Descriptions.Item>
        <Descriptions.Item label="最近一次仍在报告里">{timeOf(issue.lastSeenAt)}</Descriptions.Item>
        <Descriptions.Item label="涉及 ASIN">{issue.asins.length ? issue.asins.join('、') : <Muted>报告没有给出</Muted>}</Descriptions.Item>
        <Descriptions.Item label="影响">{issue.impactText ?? <Muted>报告没有给出</Muted>}</Descriptions.Item>
        <Descriptions.Item label="问题编号">{issue.issueId.startsWith('h:') ? <Muted>报告没有编号，系统按内容生成</Muted> : issue.issueId}</Descriptions.Item>
      </Descriptions>
      <Descriptions size="small" column={1} bordered title="处理信息" extra={<HandleAction detail={detail} onDone={onChanged} />} data-testid="issue-handling">
        <Descriptions.Item label="负责人">{issue.owner?.name ?? <Muted>未指定</Muted>}</Descriptions.Item>
        <Descriptions.Item label="处理状态">
          <HandlingTag status={issue.handlingStatus} label={issue.handlingStatusLabel} />
        </Descriptions.Item>
        <Descriptions.Item label="处理备注">{issue.handlingNote ?? <Muted>尚无记录</Muted>}</Descriptions.Item>
        <Descriptions.Item label="亚马逊案件编号">{issue.amazonCaseId ?? <Muted>尚未填写</Muted>}</Descriptions.Item>
      </Descriptions>
      <div data-testid="issue-support">
        <SectionTitle label="关联的支持案件" />
        {support.state === 'OK' ? (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {support.cases.map(item => (
              <li key={item.id}>
                {item.caseId}：{item.subject}（{item.statusLabel}，{formatDateTime(item.updatedAt)}；{item.via === 'MANUAL' ? '按你填写的案件编号关联' : '案件主题里含有问题编号'}）
              </li>
            ))}
          </ul>
        ) : (
          <Muted>
            {support.state === 'NOT_CONNECTED' ? '尚未接入：' : ''}
            {support.note}
          </Muted>
        )}
      </div>
      <div data-testid="issue-timeline">
        <SectionTitle label="处理记录" />
        {timeline.length ? (
          <Timeline items={timeline.map(item => ({ key: item.id, children: `${formatDateTime(item.at)}${item.actorName ? ` · ${item.actorName}` : ''}：${item.title}` }))} />
        ) : (
          <Muted>尚无处理记录</Muted>
        )}
      </div>
    </Space>
  )
}

function SectionTitle({ label }: { label: string }) {
  return <div style={{ fontWeight: 600, marginBottom: 6 }}>{label}</div>
}

export function PolicyIssueDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const query = useApiQuery<PolicyIssueDetail>({ domain: 'list', path: `/account-health/issues/${encodeURIComponent(id ?? '')}`, scoped: false, enabled: Boolean(id) })
  return (
    <Drawer open={Boolean(id)} onClose={onClose} width={640} title="政策合规问题" destroyOnClose data-testid="policy-issue-drawer">
      {query.error ? <DataState {...stateFromError(describeError(query.error), { permission: 'account.health.read', onRetry: () => void query.refetch() })} /> : null}
      {!query.error && (query.isPending || !query.data) && id ? <DataState kind="skeleton" rows={6} /> : null}
      {query.data && !query.error ? <Body detail={query.data} onChanged={() => void query.refetch()} /> : null}
      {query.data?.issue.status === 'RESOLVED' ? <Alert type="info" showIcon style={{ marginTop: 12 }} message="这个问题已不在最近的报告里，系统已标记为已解决；再次出现会自动重开。" /> : null}
    </Drawer>
  )
}
