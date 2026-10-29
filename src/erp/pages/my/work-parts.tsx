import { Descriptions, Drawer, Form, Input, Select, Space, Tag, Timeline, Typography } from 'antd'
import { WORK_CLOSE_CONCLUSIONS, WORK_DEFER_MAX_DAYS, type WorkDueGroup } from '@nova/api-contracts'
import { DataState, EntityCollaboration, FormAction } from '../../components'
import { formatDateTime, formatMoney } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { useSession } from '../../session/session'

export type WorkItemRow = {
  id: string
  title: string
  source: string
  status: string
  severity: string
  dueAt: string | null
  overdue: boolean
  remainingMinutes: number | null
  groupKey: WorkDueGroup
  entity: { type: string; id: string | null; label: string | null } | null
  impact: { min: number | null; max: number | null; currency: string } | null
  suggestedAction: string | null
  owner: { id: string; name: string }
  createdBy: { id: string; name: string }
  deferredUntil: string | null
  closeConclusion: string | null
  ignoreReason: string | null
  version: number
}
type Detail = WorkItemRow & {
  detail: string | null
  closeNote: string | null
  trigger: { ruleName: string; triggerCount: number; firstTriggeredAt: string; evidence: Array<{ label: string; value: string }> } | null
  assignments: Array<{ assignee: string; assignedBy: string; assignedAt: string }>
  timeline: Array<{ id: string; at: string; title: string; actor: string }>
}
type Member = { status: string; user: { id: string; displayName: string; email: string } }

export const SEVERITY_TAG = { CRITICAL: ['严重', 'error'], WARNING: ['警告', 'warning'], INFO: ['提示', 'default'] } as const
export const STATUS_LABEL: Record<string, string> = { PENDING: '待处理', IN_PROGRESS: '处理中', DONE: '已完成', CLOSED: '已关闭' }
export const SOURCE_LABEL: Record<string, string> = { ALERT: '预警', MANUAL: '手工创建', SYSTEM: '系统' }
const CONCLUSION_LABEL: Record<string, string> = { HANDLED: '已处理', NOT_NEEDED: '无需处理', FALSE_POSITIVE: '误报', IGNORED: '已忽略' }
const isOpen = (item: Pick<WorkItemRow, 'status'>) => item.status === 'PENDING' || item.status === 'IN_PROGRESS'

export function dueText(item: WorkItemRow): string {
  if (!isOpen(item) || !item.dueAt) return item.dueAt ? formatDateTime(item.dueAt) : '没有截止时间'
  if (item.overdue) return `已超时 · ${formatDateTime(item.dueAt)}`
  const minutes = item.remainingMinutes ?? 0
  const left = minutes >= 1440 ? `${Math.round(minutes / 1440)} 天` : minutes >= 60 ? `${Math.round(minutes / 60)} 小时` : `${Math.max(minutes, 0)} 分钟`
  return `剩 ${left} · ${formatDateTime(item.dueAt)}`
}

/** 行内操作：确认、转派、延期、关闭、忽略；每个动作都真实调用服务端，条件不满足时禁用并说明原因。 */
export function RowActions({ item, onDone }: { item: WorkItemRow; onDone: () => void }) {
  const { me, canPermission } = useSession()
  const act = useApiMutation<{ path: string; body: unknown }, unknown>({ method: 'POST', path: v => v.path, body: v => v.body, invalidate: ['realtime', 'list'], silent: true })
  const members = useApiQuery<Member[]>({ domain: 'reference', path: '/members/options', scoped: false, enabled: canPermission('member.read') && isOpen(item) })
  if (!isOpen(item)) return <span>{item.closeConclusion ? (CONCLUSION_LABEL[item.closeConclusion] ?? item.closeConclusion) : (STATUS_LABEL[item.status] ?? item.status)}</span>
  const mine = item.owner.id === me.user.id
  const handle = { permission: 'workitem.handle', condition: { ok: mine || canPermission('workitem.assign'), reason: '只有待办负责人或有指派权限的成员可以处理这条待办' } }
  const base = `/work-items/${encodeURIComponent(item.id)}`
  const send = (action: string, body: Record<string, unknown>) => act.mutateAsync({ path: `${base}/${action}`, body: { ...body, version: item.version } })
  const small = { size: 'small' as const, type: 'link' as const }
  const candidates = (members.data ?? []).filter(member => member.status === 'ACTIVE' && member.user.id !== item.owner.id)
  return (
    <Space size={0} wrap>
      {item.status === 'PENDING' ? (
        <FormAction
          label="确认"
          guard={handle}
          title="确认开始处理"
          description="确认后状态变为“处理中”，创建人与关注人会看到处理进展。"
          okText="确认"
          onSubmit={() => send('ack', {})}
          onDone={onDone}
          buttonProps={small}
        />
      ) : null}
      <FormAction
        label="转派"
        guard={{ permission: 'workitem.assign', condition: { ok: canPermission('member.read'), reason: '选择指派对象需要“成员查看”权限' } }}
        title="转派待办"
        onSubmit={values => send('assign', { assigneeId: values.assigneeId, note: values.note || undefined })}
        okText="转派"
        successText="已转派"
        onDone={onDone}
        buttonProps={small}
      >
        <Form.Item label="转派给" name="assigneeId" rules={[{ required: true, message: '请选择成员' }]}>
          <Select showSearch optionFilterProp="label" placeholder="选择在职成员" options={candidates.map(member => ({ value: member.user.id, label: member.user.displayName || member.user.email }))} />
        </Form.Item>
        <Form.Item label="备注（可选）" name="note">
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
      </FormAction>
      <FormAction
        label="延期"
        guard={handle}
        title="延期处理"
        description={`最长可延期 ${WORK_DEFER_MAX_DAYS} 天；延期后重新计时，到期仍未处理会再次升级。`}
        reason={{ label: '延期原因' }}
        onSubmit={values => send('defer', { until: new Date(`${values.until}T23:59:59`).toISOString(), reason: values.reason })}
        okText="延期"
        successText="已延期"
        onDone={onDone}
        buttonProps={small}
      >
        <Form.Item label="延期到" name="until" rules={[{ required: true, message: '请选择日期' }]}>
          <Input
            type="date"
            min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
            max={new Date(Date.now() + WORK_DEFER_MAX_DAYS * 86_400_000).toISOString().slice(0, 10)}
            style={{ width: 200 }}
          />
        </Form.Item>
      </FormAction>
      <FormAction
        label="关闭"
        guard={handle}
        title="关闭待办"
        onSubmit={values => send('close', { conclusion: values.conclusion, note: values.note || undefined })}
        okText="关闭"
        successText="已关闭"
        onDone={onDone}
        buttonProps={small}
      >
        <Form.Item label="处理结论" name="conclusion" rules={[{ required: true, message: '请选择处理结论' }]} extra="结论会回流到预警规则的质量统计（误报率）。">
          <Select options={WORK_CLOSE_CONCLUSIONS.map(value => ({ value, label: CONCLUSION_LABEL[value] }))} />
        </Form.Item>
        <Form.Item label="备注（可选）" name="note">
          <Input.TextArea rows={2} maxLength={1000} />
        </Form.Item>
      </FormAction>
      <FormAction
        label="忽略"
        guard={handle}
        title="忽略待办"
        description="忽略后不再提醒；如果相同问题再次出现，会在冷却时间之后重新提醒。"
        reason={{ label: '忽略原因' }}
        okText="忽略"
        onSubmit={values => send('ignore', { reason: values.reason })}
        successText="已忽略"
        onDone={onDone}
        buttonProps={small}
      />
    </Space>
  )
}

export function WorkDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const query = useApiQuery<Detail>({ domain: 'realtime', path: `/work-items/${id ?? ''}`, scoped: false, enabled: id !== null })
  const item = query.data
  const sev = item ? (SEVERITY_TAG[item.severity as keyof typeof SEVERITY_TAG] ?? ['—', 'default']) : null
  return (
    <Drawer open={id !== null} onClose={onClose} width={640} title={item?.title ?? '待办详情'} destroyOnClose>
      {query.isError ? <DataState kind="server-error" message={query.error.message} onRetry={() => void query.refetch()} /> : null}
      {query.isPending && id ? <DataState kind="skeleton" rows={6} /> : null}
      {item ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="严重度">{sev ? <Tag color={sev[1]}>{sev[0]}</Tag> : null}</Descriptions.Item>
            <Descriptions.Item label="状态">{STATUS_LABEL[item.status] ?? item.status}</Descriptions.Item>
            <Descriptions.Item label="负责人">{item.owner.name}</Descriptions.Item>
            <Descriptions.Item label="创建人">{item.createdBy.name}</Descriptions.Item>
            <Descriptions.Item label="处理时限" span={2}>
              {dueText(item)}
            </Descriptions.Item>
            {item.entity ? (
              <Descriptions.Item label="关联对象" span={2}>
                {item.entity.label ?? item.entity.id}
              </Descriptions.Item>
            ) : null}
            {item.impact ? (
              <Descriptions.Item label="影响金额" span={2}>
                {[item.impact.min, item.impact.max]
                  .filter(value => value !== null)
                  .map(value => formatMoney(value, item.impact?.currency))
                  .join(' ~ ')}
              </Descriptions.Item>
            ) : null}
            {item.suggestedAction ? (
              <Descriptions.Item label="建议动作" span={2}>
                {item.suggestedAction}
              </Descriptions.Item>
            ) : null}
            {item.detail ? (
              <Descriptions.Item label="说明" span={2}>
                {item.detail}
              </Descriptions.Item>
            ) : null}
          </Descriptions>
          {item.trigger ? (
            <div>
              <Typography.Title level={5}>触发原因</Typography.Title>
              <div>
                规则：{item.trigger.ruleName}；已触发 {item.trigger.triggerCount} 次，首次 {formatDateTime(item.trigger.firstTriggeredAt)}
              </div>
              {item.trigger.evidence.length > 0 ? (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {item.trigger.evidence.map(entry => (
                    <li key={entry.label}>
                      {entry.label}：{entry.value}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div>
            <Typography.Title level={5}>处理记录</Typography.Title>
            {item.timeline.length === 0 ? (
              <Typography.Text type="secondary">暂无处理记录</Typography.Text>
            ) : (
              <Timeline items={item.timeline.map(entry => ({ key: entry.id, children: `${formatDateTime(entry.at)} · ${entry.actor} · ${entry.title}` }))} />
            )}
          </div>
          <div>
            <Typography.Title level={5}>评论与关注</Typography.Title>
            <EntityCollaboration entityType="WORK_ITEM" entityId={item.id} />
          </div>
        </Space>
      ) : null}
    </Drawer>
  )
}
