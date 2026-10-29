import { Alert, Drawer, Form, Input, Select, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { REPLENISH_LEVEL_LABEL, TRANSPORT_PREFERENCE_LABEL, type PolicyListResponse, type PolicyUpsertBody, type ReplenishPolicy } from '@nova/api-contracts'
import { DataState, FormAction, RowDetailDrawer, SimpleGrid, stateFromError, useRowDetail } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { initialOf, PolicyFields, toBody } from './policy-form'

// 补货策略抽屉：企业级、品类级、SKU 级三层，每个对象一行显示当前版本，展开看历史版本。
// 下级整行覆盖上级（不逐项继承）：新增品类或 SKU 级策略时以企业级当前版本作为起点，改哪项就改哪项。
// 旧版库存规则保存的策略没有服务水平与提前期拆分，这里显示“待补齐”，在补齐之前该范围内的 SKU 不会产出建议（不套默认值）。

export const POLICY_WRITE = 'replenishment.policy.write'
type Level = PolicyUpsertBody['level']

const complete = (policy: ReplenishPolicy) => policy.serviceLevel !== null && policy.productionDays !== null && policy.domesticDays !== null && policy.receivingDays !== null

/** 每个对象的当前版本：列表按（级别、对象、版本号倒序）排好，各对象第一条就是最新版本。 */
export function latestPerObject(items: ReplenishPolicy[]): ReplenishPolicy[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = `${item.level}:${item.levelRef}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function History({ versions }: { versions: ReplenishPolicy[] }) {
  return (
    <SimpleGrid<ReplenishPolicy>
      gridId="replenishment.policy-drawer"
      columns={[
        { title: '版本', dataIndex: 'versionNo', width: 70, render: (value: number) => `第 ${value} 版` },
        { title: '生效日期', dataIndex: 'effectiveFrom', width: 110 },
        { title: '设置人', dataIndex: 'createdBy', width: 100 },
        { title: '原因', dataIndex: 'changeReason' },
      ]}
      rows={versions}
      rowKey={row => row.versionNo}
      emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
    />
  )
}

export function PolicyDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const policies = useApiQuery<PolicyListResponse>({ domain: 'config', path: '/replenishment/policies', params: { pageSize: 100 }, scoped: false, enabled: open })
  const save = useApiMutation<PolicyUpsertBody, ReplenishPolicy>({ method: 'PUT', path: '/replenishment/policies', invalidate: ['config', 'list', 'analytics'], silent: true })
  const data = policies.data
  const latest = latestPerObject(data?.items ?? [])
  const byObject = (policy: ReplenishPolicy) => (data?.items ?? []).filter(item => item.level === policy.level && item.levelRef === policy.levelRef)
  const base = data?.tenantCurrent ?? null
  const history = useRowDetail()

  const columns: ColumnsType<ReplenishPolicy> = [
    { title: '级别', dataIndex: 'level', width: 80, render: (value: Level) => REPLENISH_LEVEL_LABEL[value] },
    { title: '对象', dataIndex: 'levelRef', width: 140, render: (value: string, row) => (row.level === 'TENANT' ? '全部（企业默认）' : value) },
    {
      title: '版本',
      dataIndex: 'versionNo',
      width: 120,
      render: (value: number, row) =>
        complete(row) ? (
          `第 ${value} 版`
        ) : (
          <Tag color="warning" bordered={false}>
            第 {value} 版 · 待补齐
          </Tag>
        ),
    },
    { title: '总提前期', dataIndex: 'leadTimeDays', width: 90, render: (value: number) => `${value} 天` },
    { title: '目标覆盖', dataIndex: 'coverageDays', width: 90, render: (value: number) => `${value} 天` },
    { title: '服务水平', dataIndex: 'serviceLevel', width: 90, render: (value: number | null) => (value === null ? <Typography.Text type="secondary">未设置</Typography.Text> : value) },
    { title: '计入必断货量', dataIndex: 'includeUnavoidableShortage', width: 110, render: (value: boolean) => (value ? '计入' : '不计入') },
    {
      title: '运输',
      dataIndex: 'transportPreference',
      width: 150,
      render: (value: ReplenishPolicy['transportPreference']) => (value ? TRANSPORT_PREFERENCE_LABEL[value] : <Typography.Text type="secondary">未设置</Typography.Text>),
    },
    {
      title: '操作',
      key: 'op',
      width: 130,
      render: (_value, row) => (
        <FormAction
          label="保存新版本"
          guard={{ permission: POLICY_WRITE }}
          title={`保存新版本：${REPLENISH_LEVEL_LABEL[row.level]}${row.level === 'TENANT' ? '' : ` ${row.levelRef}`}`}
          reason={{ label: '调整原因', placeholder: '例如：旺季前把提前期调长' }}
          initialValues={initialOf(row)}
          okText="保存"
          successText="已保存新版本"
          buttonProps={{ size: 'small' }}
          onSubmit={values => save.mutateAsync(toBody(values, { level: row.level, levelRef: row.levelRef }, row.versionNo))}
        >
          <PolicyFields />
        </FormAction>
      ),
    },
  ]

  const create = (level: Exclude<Level, 'TENANT'>) => (
    <FormAction
      key={level}
      label={level === 'CATEGORY' ? '新增品类级策略' : '新增 SKU 级策略'}
      guard={{ permission: POLICY_WRITE }}
      title={level === 'CATEGORY' ? '新增品类级策略' : '新增 SKU 级策略'}
      description={base ? '以企业级当前版本为起点，改哪项就改哪项；保存后该对象整行使用这套参数。' : undefined}
      reason={{ label: '设置原因', placeholder: '例如：该品类海运时效更长' }}
      initialValues={initialOf(base)}
      okText="保存"
      successText="已保存"
      onSubmit={values => save.mutateAsync(toBody(values, { level, levelRef: String(values.levelRef ?? '').trim() }, 0))}
    >
      <Form.Item label={level === 'CATEGORY' ? '品类（商品类型）' : '卖家 SKU'} name="levelRef" rules={[{ required: true, whitespace: true, message: '请填写对象' }]}>
        {level === 'CATEGORY' ? (
          <Select showSearch style={{ width: 280 }} options={(data?.categories ?? []).map(item => ({ value: item, label: item }))} placeholder="选择品类" />
        ) : (
          <Input style={{ width: 280 }} maxLength={120} placeholder="输入范围内存在的卖家 SKU" />
        )}
      </Form.Item>
      <PolicyFields />
    </FormAction>
  )

  return (
    <Drawer open={open} onClose={onClose} width={920} title="补货策略" destroyOnClose>
      {policies.error ? <DataState {...stateFromError(describeError(policies.error), { onRetry: () => void policies.refetch() })} /> : null}
      {policies.isPending && !policies.error ? <DataState kind="skeleton" rows={6} /> : null}
      {data ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            策略分三级：SKU 级覆盖品类级，品类级覆盖企业级，下级整行替换上级。每次保存都新增一个版本，旧版本不会被改写；批次会冻结当时使用的版本。
          </Typography.Paragraph>
          {base ? null : <Alert type="info" showIcon message="尚未配置企业级策略" description="先设置企业级策略，品类级与 SKU 级才能以它为起点；没有任何策略时不会产出补货建议。" />}
          {latest.some(item => !complete(item)) ? (
            <Alert type="warning" showIcon message="有策略待补齐" description="来自库存规则的旧版本没有服务水平与提前期拆分，请保存新版本补齐；补齐前这些范围内的 SKU 不会产出建议。" />
          ) : null}
          <Space wrap>
            {base ? null : (
              <FormAction
                label="设置企业级策略"
                guard={{ permission: POLICY_WRITE }}
                title="设置企业级策略"
                reason={{ label: '设置原因' }}
                initialValues={initialOf(null)}
                okText="保存"
                successText="已保存"
                onSubmit={values => save.mutateAsync(toBody(values, { level: 'TENANT', levelRef: 'ALL' }, 0))}
              >
                <PolicyFields />
              </FormAction>
            )}
            {create('CATEGORY')}
            {create('SKU')}
          </Space>
          <SimpleGrid<ReplenishPolicy>
            gridId="replenishment.policy-latest"
            rows={latest}
            rowKey={row => `${row.level}:${row.levelRef}`}
            columns={columns}
            onRowOpen={row => history.open(`${row.level}:${row.levelRef}`)}
            emptyState={{ kind: 'empty', domain: '补货策略', prerequisite: '尚未配置任何策略' }}
          />
          <RowDetailDrawer
            rows={latest}
            rowKey={row => `${row.level}:${row.levelRef}`}
            openKey={history.openKey}
            onClose={history.close}
            title={row => `历史版本：${REPLENISH_LEVEL_LABEL[row.level]} ${row.levelRef}`}
            width={640}
          >
            {row => <History versions={byObject(row)} />}
          </RowDetailDrawer>
        </Space>
      ) : null}
    </Drawer>
  )
}
