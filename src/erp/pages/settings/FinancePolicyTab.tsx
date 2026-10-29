import { Alert, Card, Descriptions, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { POLICY_STATUS_LABEL, policyValueText, type FinancePolicyResponse, type PolicyFieldInfo, type PolicyStatus, type PolicyVersionView } from '@nova/api-contracts'
import { DataState, SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { stateFromError } from '../../components/data-state/from-error'
import { describeError } from '../../query/errors'
import { useApiQuery } from '../../query/api-query'
import { ChangeList, DecisionActions, SubmitAction } from './finance-policy-forms'

// 财务口径（P2b-15，09 章 9.12 第 2 个页签）：收入确认口径、存货计价方法、汇率折算规则、广告分摊规则、店铺级费用分摊规则。
// 修改要经审批（发起人与审批人不能是同一人），带版本；已关账与关账中的期间不会因口径变化而重算。
// 只有存货计价现在被计算使用；其余口径登记在版本里，页面逐项写明“尚未用于计算”，不假装已经生效。

const STATUS_COLOR: Record<PolicyStatus, string> = { PENDING: 'processing', ACTIVE: 'success', REPLACED: 'default', REJECTED: 'error' }

const statusTag = (row: PolicyVersionView) => <Tag color={STATUS_COLOR[row.status]}>{row.status === 'REJECTED' && row.withdrawn ? '已撤回' : POLICY_STATUS_LABEL[row.status]}</Tag>

function currentColumns(data: FinancePolicyResponse): ColumnsType<PolicyFieldInfo> {
  return [
    { title: '口径', dataIndex: 'label', width: 150 },
    { title: '当前取值', key: 'value', width: 260, render: (_value, row) => <b>{policyValueText(row.key, data.current.values[row.key] as never)}</b> },
    { title: '说明', dataIndex: 'description' },
    {
      title: '使用情况',
      key: 'consumer',
      width: 360,
      render: (_value, row) => (
        <Space direction="vertical" size={2}>
          <Tag color={row.consumer === 'WIRED' ? 'success' : 'warning'}>{row.consumer === 'WIRED' ? '已用于计算' : '仅登记，尚未用于计算'}</Tag>
          <Typography.Text type="secondary">{row.consumerNote}</Typography.Text>
          {row.editable ? null : <Typography.Text type="secondary">只有这一种规则，不能修改。</Typography.Text>}
        </Space>
      ),
    },
  ]
}

const historyColumns: ColumnsType<PolicyVersionView> = [
  { title: '版本', dataIndex: 'versionNo', width: 70, render: (value: number) => `第 ${value} 版` },
  { title: '状态', key: 'status', width: 100, render: (_value, row) => statusTag(row) },
  { title: '生效日', dataIndex: 'effectiveFrom', width: 110 },
  {
    title: '口径',
    key: 'values',
    render: (_value, row) => (
      <Space direction="vertical" size={0}>
        <span>收入确认：{policyValueText('revenueRecognition', row.revenueRecognition)}</span>
        <span>存货计价：{policyValueText('inventoryCostMethod', row.inventoryCostMethod)}</span>
        <span>广告分摊：{policyValueText('adsAllocationMode', row.adsAllocationMode)}</span>
        <span>店铺级费用分摊：{policyValueText('storeFeeAllocation', row.storeFeeAllocation)}</span>
      </Space>
    ),
  },
  {
    title: '发起',
    key: 'created',
    width: 220,
    render: (_value, row) => (
      <Space direction="vertical" size={0}>
        <span>
          {row.createdByName ?? '—'} · {formatDateTime(row.createdAt)}
        </span>
        <Typography.Text type="secondary">{row.reason}</Typography.Text>
      </Space>
    ),
  },
  {
    title: '处理',
    key: 'decided',
    width: 220,
    render: (_value, row) =>
      row.decidedAt ? (
        <Space direction="vertical" size={0}>
          <span>
            {row.decidedByName ?? '—'} · {formatDateTime(row.decidedAt)}
          </span>
          {row.decisionComment ? <Typography.Text type="secondary">{row.decisionComment}</Typography.Text> : null}
        </Space>
      ) : (
        <Typography.Text type="secondary">—</Typography.Text>
      ),
  },
]

function PendingCard({ data, pending }: { data: FinancePolicyResponse; pending: PolicyVersionView }) {
  return (
    <Card size="small" title={`待审批：第 ${pending.versionNo} 版`} extra={<Space>{<DecisionActions data={data} pending={pending} />}</Space>} data-testid="policy-pending">
      <Descriptions size="small" column={2}>
        <Descriptions.Item label="发起人">{pending.createdByName}</Descriptions.Item>
        <Descriptions.Item label="提交时间">{formatDateTime(pending.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="生效日">{pending.effectiveFrom}</Descriptions.Item>
        <Descriptions.Item label="修改原因">{pending.reason}</Descriptions.Item>
        <Descriptions.Item label="相对当前口径的变化" span={2}>
          <ChangeList current={data.current.values} pending={pending} />
        </Descriptions.Item>
      </Descriptions>
      {data.actions.approve.allowed ? null : (
        <Typography.Text type="secondary" data-testid="policy-approve-hint">
          {data.actions.approve.reason}
        </Typography.Text>
      )}
    </Card>
  )
}

export default function FinancePolicyTab() {
  const query = useApiQuery<FinancePolicyResponse>({ domain: 'config', path: '/settings/finance-policy', scoped: false })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'settings.read', onRetry: () => void query.refetch() })} />
  const data = query.data
  if (!data) return <DataState kind="skeleton" rows={5} />
  const { current } = data
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="修改财务口径要经审批"
        description={`发起人提交后，需要另一位有“修改财务口径”权限的成员审批通过才生效，提交与审批都要再次验证身份。已关账与关账中的期间（现有 ${data.frozenPeriodCount} 个）的利润不会因口径变化而重算；要改它们，先重新开账。`}
      />
      {current.inventoryMethodValid ? null : <Alert type="warning" showIcon message="企业设置里的存货计价取值不合法，利润计算现按先进先出处理；提交一次新的口径可以修正。" />}
      <Card
        size="small"
        title={current.source === 'VERSION' ? `当前口径：第 ${current.versionNo} 版（生效日 ${current.effectiveFrom}）` : '当前口径：系统默认（还没有审批过的版本）'}
        extra={<SubmitAction data={data} />}
      >
        <SimpleGrid
          gridId="settings.finance-policy-tab"
          columns={currentColumns(data)}
          rows={data.fields}
          rowKey={row => row.key}
          emptyState={{ kind: 'empty', domain: '财务口径', prerequisite: '口径项由系统定义，不应为空' }}
        />
      </Card>
      {data.pending ? <PendingCard data={data} pending={data.pending} /> : null}
      <Card size="small" title="历史版本">
        <SimpleGrid
          gridId="settings.finance-policy-tab-2"
          columns={historyColumns}
          rows={data.history}
          rowKey={row => row.id}
          emptyState={{ kind: 'empty', domain: '口径版本', prerequisite: '尚无记录：还没有提交过口径修改，现在用的是系统默认口径。' }}
        />
        {data.historyTruncated ? <Typography.Text type="secondary">只显示最近 {data.history.length} 个版本。</Typography.Text> : null}
      </Card>
    </Space>
  )
}
