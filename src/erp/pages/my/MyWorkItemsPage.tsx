import { useState } from 'react'
import { Button, Form, Input, Segmented, Select, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { WORK_SEVERITIES, WORK_SOURCES, WORK_TABS, WORK_TAB_LABEL, type WorkTab } from '@nova/api-contracts'
import { FormAction, PageHeader, SimpleGrid } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { useSession } from '../../session/session'
import { RowActions, SEVERITY_TAG, SOURCE_LABEL, STATUS_LABEL, WorkDrawer, dueText, type WorkItemRow } from './work-parts'

// 我的待办（P1-28-3，04 章 4.3）：预警自动生成的与手工创建的待办，按页签、来源、严重度筛选。
// - 处理时限按严重度计时，超时后后台自动升级并通知负责人与管理员；列表里“已超时”标红；
// - 确认、转派、延期、关闭（要选结论，结论回流到预警规则质量）、忽略（要写原因）都真实调用服务端，并带版本号防止覆盖他人刚做的修改；
// - 没有权限、不是负责人的待办，操作按钮禁用并说明原因；详情抽屉里看触发原因、证据、处理记录，并可评论与关注。

type Counts = Record<WorkTab, number>
type Page = { items: WorkItemRow[]; pageInfo: { nextCursor: string | null; hasMore: boolean }; counts: Counts | null }
type Member = { status: string; user: { id: string; displayName: string; email: string } }

const SEVERITY_OPTIONS = WORK_SEVERITIES.map(value => ({ value, label: SEVERITY_TAG[value][0] }))
const SOURCE_OPTIONS = WORK_SOURCES.map(value => ({ value, label: SOURCE_LABEL[value] }))
const PRIORITY_OPTIONS = [
  { value: 'LOW', label: '低' },
  { value: 'NORMAL', label: '普通' },
  { value: 'HIGH', label: '高' },
  { value: 'URGENT', label: '紧急' },
]

export default function MyWorkItemsPage() {
  const { me, canPermission } = useSession()
  const canSeeAll = canPermission('workitem.read')
  const [tab, setTab] = useState<WorkTab>('MINE')
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [source, setSource] = useState<string>()
  const [severity, setSeverity] = useState<string>()
  const [cursors, setCursors] = useState<string[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const cursor = cursors[cursors.length - 1]
  const query = useApiQuery<Page>({ domain: 'realtime', path: '/work-items', scoped: false, params: { tab, scope, source, severity, cursor, limit: 30 } })
  const members = useApiQuery<Member[]>({ domain: 'reference', path: '/members/options', scoped: false, enabled: canPermission('member.read') })
  const create = useApiMutation<Record<string, unknown>, unknown>({ method: 'POST', path: '/work-items', invalidate: ['realtime'], silent: true })
  const reset = () => setCursors([])
  const refresh = () => void query.refetch()
  const counts = query.data?.counts

  const columns: ColumnsType<WorkItemRow> = [
    {
      title: '待办',
      key: 'title',
      render: (_, item) => (
        <div>
          <Typography.Link onClick={() => setOpenId(item.id)}>{item.title}</Typography.Link>
          {item.entity?.label ? <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>{item.entity.label}</div> : null}
        </div>
      ),
    },
    {
      title: '严重度',
      dataIndex: 'severity',
      width: 80,
      render: (value: string) => <Tag color={SEVERITY_TAG[value as keyof typeof SEVERITY_TAG]?.[1]}>{SEVERITY_TAG[value as keyof typeof SEVERITY_TAG]?.[0] ?? value}</Tag>,
    },
    { title: '来源', dataIndex: 'source', width: 90, render: (value: string) => SOURCE_LABEL[value] ?? value },
    { title: '状态', dataIndex: 'status', width: 80, render: (value: string) => STATUS_LABEL[value] ?? value },
    { title: '负责人', key: 'owner', width: 100, render: (_, item) => (item.owner.id === me.user.id ? '我' : item.owner.name) },
    { title: '处理时限', key: 'due', width: 230, render: (_, item) => <span style={{ color: item.overdue ? 'var(--ant-color-error)' : undefined }}>{dueText(item)}</span> },
    { title: '操作', key: 'actions', width: 330, render: (_, item) => <RowActions item={item} onDone={refresh} /> },
  ]

  const actions = (
    <FormAction
      label="创建待办"
      guard={{ permission: 'workitem.assign' }}
      title="创建待办"
      initialValues={{ severity: 'INFO', priority: 'NORMAL', ownerId: me.user.id }}
      onSubmit={values =>
        create.mutateAsync({
          title: values.title,
          detail: values.detail || undefined,
          severity: values.severity,
          priority: values.priority,
          ownerId: values.ownerId,
          dueAt: values.dueDate ? new Date(`${values.dueDate}T23:59:59`).toISOString() : undefined,
        })
      }
      successText="已创建"
      onDone={reset}
    >
      <Form.Item
        label="标题"
        name="title"
        rules={[
          { required: true, whitespace: true, message: '请填写标题' },
          { min: 2, message: '至少 2 个字' },
        ]}
      >
        <Input maxLength={200} />
      </Form.Item>
      <Form.Item label="说明（可选）" name="detail">
        <Input.TextArea rows={3} maxLength={2000} />
      </Form.Item>
      <Space size={12} wrap>
        <Form.Item label="严重度" name="severity">
          <Select style={{ width: 120 }} options={SEVERITY_OPTIONS} />
        </Form.Item>
        <Form.Item label="优先级" name="priority">
          <Select style={{ width: 120 }} options={PRIORITY_OPTIONS} />
        </Form.Item>
        <Form.Item label="截止日期（可选，不填按严重度的默认时限）" name="dueDate">
          <Input type="date" min={new Date().toISOString().slice(0, 10)} style={{ width: 200 }} />
        </Form.Item>
      </Space>
      <Form.Item label="负责人" name="ownerId" extra={canPermission('member.read') ? undefined : '没有“成员查看”权限，只能指派给自己'}>
        <Select
          showSearch
          optionFilterProp="label"
          options={
            canPermission('member.read')
              ? (members.data ?? []).filter(member => member.status === 'ACTIVE').map(member => ({ value: member.user.id, label: member.user.displayName || member.user.email }))
              : [{ value: me.user.id, label: `${me.user.displayName}（我）` }]
          }
        />
      </Form.Item>
    </FormAction>
  )

  return (
    <div>
      <PageHeader title="我的待办" description="需要你处理的事项：预警自动生成，或由同事指派、手工创建。超过处理时限会自动升级给管理员。" actions={actions} />
      <Space wrap style={{ margin: '8px 0 12px' }}>
        <Segmented
          value={tab}
          onChange={value => {
            setTab(value as WorkTab)
            reset()
          }}
          options={WORK_TABS.map(value => ({ value, label: `${WORK_TAB_LABEL[value]}${counts ? `（${counts[value]}）` : ''}` }))}
        />
        <Select allowClear placeholder="来源" style={{ width: 120 }} value={source} options={SOURCE_OPTIONS} onChange={value => (setSource(value), reset())} />
        <Select allowClear placeholder="严重度" style={{ width: 120 }} value={severity} options={SEVERITY_OPTIONS} onChange={value => (setSeverity(value), reset())} />
        {canSeeAll ? (
          <Segmented
            value={scope}
            onChange={value => {
              setScope(value as 'mine' | 'all')
              reset()
            }}
            options={[
              { value: 'mine', label: '与我相关' },
              { value: 'all', label: '全部待办' },
            ]}
          />
        ) : null}
      </Space>
      <SimpleGrid<WorkItemRow>
        gridId="my.my-work-items-page"
        columns={columns}
        rows={query.data?.items}
        rowKey={item => item.id}
        loading={query.isPending}
        error={query.error}
        onRetry={refresh}
        emptyState={{ kind: 'empty', domain: `“${WORK_TAB_LABEL[tab]}”下没有待办`, prerequisite: '预警触发、同事指派或手工创建后会出现在这里。' }}
      />
      <Space style={{ marginTop: 12 }}>
        <Button disabled={cursors.length === 0} onClick={() => setCursors(list => list.slice(0, -1))}>
          上一页
        </Button>
        <Button disabled={!query.data?.pageInfo.hasMore || !query.data.pageInfo.nextCursor} onClick={() => setCursors(list => [...list, query.data?.pageInfo.nextCursor as string])}>
          下一页
        </Button>
      </Space>
      <WorkDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  )
}
