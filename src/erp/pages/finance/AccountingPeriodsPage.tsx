import { useCallback, useState } from 'react'
import { Card, Form, Input, Select, Space } from 'antd'
import { PERIOD_STATUSES, PERIOD_STATUS_LABEL, type PeriodListResponse, type PeriodRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PageHeader, PagedGrid, type PageFetcher } from '../../components'
import { buildPath, useApiMutation } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { periodColumns } from './periods-columns'

// 期间关账列表（P2b-13，07 章 7.12）：一个店铺一个自然月（企业数据口径时区）。关账 = 完整性检查 → 审批 → 锁定快照；锁定后利润日表不再重算、期间内汇率不能改。
// 这里只管创建与看进度，检查、审批、锁定、重新开账都在期间详情里做。

const STATUS_OPTIONS = PERIOD_STATUSES.map(value => ({ value, label: PERIOD_STATUS_LABEL[value] }))

function CreateAction({ data, onDone }: { data: PeriodListResponse; onDone: () => void }) {
  const create = useApiMutation<{ sellerAccountId: string; month: string }>({ method: 'POST', path: '/finance/periods', invalidate: ['list'], silent: true })
  return (
    <FormAction
      label="创建期间"
      buttonProps={{ type: 'primary' }}
      guard={{ condition: { ok: data.canCreate, reason: '没有创建期间的权限，或范围内没有可关账的店铺' } }}
      title="创建关账期间"
      description="一个店铺一个自然月，按企业数据口径时区的日历月划分。同一店铺同一个月只能有一个期间。"
      okText="创建"
      onDone={onDone}
      successText="期间已创建"
      onSubmit={values => create.mutateAsync({ sellerAccountId: String(values.sellerAccountId), month: String(values.month).trim() })}
    >
      <Form.Item label="店铺" name="sellerAccountId" rules={[{ required: true, message: '请选择店铺' }]}>
        <Select aria-label="店铺" placeholder="选择店铺" options={data.stores.map(store => ({ value: store.id, label: store.name }))} />
      </Form.Item>
      <Form.Item label="月份" name="month" rules={[{ required: true, pattern: /^\d{4}-(0[1-9]|1[0-2])$/, message: '月份格式应为 YYYY-MM（年-月）' }]}>
        <Input aria-label="月份" placeholder="YYYY-MM" maxLength={7} />
      </Form.Item>
    </FormAction>
  )
}

export default function AccountingPeriodsPage() {
  const { apiParams } = useScope()
  const [status, setStatus] = useState<string | undefined>()
  const [meta, setMeta] = useState<PeriodListResponse | null>(null)
  // 创建期间之后要让表格从第一页重新取：把计数放进 resetKey
  const [refreshNonce, setRefreshNonce] = useState(0)
  const fetchPage = useCallback<PageFetcher<PeriodRow>>(
    async ({ page, pageSize, signal }) => {
      const data = await apiFetch<PeriodListResponse>(buildPath('/finance/periods', { ...apiParams, status, page, pageSize }), { signal })
      setMeta(data)
      return { items: data.items, total: data.total }
    },
    [apiParams, status],
  )
  const data = meta

  return (
    <div>
      <PageHeader
        title="期间关账"
        description="按店铺按月份关账：先做完整性检查（同步、结算、成本、汇率、广告分摊、对账异常），通过后由另一位有关账权限的成员审批，再锁定。锁定后该期间的利润日表不再重算、汇率不能改；需要修正只能重新开账，并留下差异报告。"
        actions={data ? <CreateAction data={data} onDone={() => setRefreshNonce(value => value + 1)} /> : undefined}
      />
      <Card size="small">
        {data ? (
          <p style={{ margin: '0 0 8px' }} data-testid="period-summary">
            {PERIOD_STATUSES.map((value, index) => (
              <span key={value}>
                {index ? '，' : ''}
                {PERIOD_STATUS_LABEL[value]} <span className="erp-num">{data.summary[value]}</span>
              </span>
            ))}
          </p>
        ) : null}
        <Space wrap style={{ margin: '8px 0' }}>
          <Select allowClear style={{ width: 150 }} placeholder="状态" aria-label="状态" value={status} options={STATUS_OPTIONS} onChange={value => setStatus(value)} />
        </Space>
        <PagedGrid<PeriodRow>
          gridId="finance.periods"
          columns={periodColumns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          resetKey={JSON.stringify([status, refreshNonce])}
          appliedFilterCount={status ? 1 : 0}
          onClearFilters={() => setStatus(undefined)}
          height={560}
          emptyState={{ kind: 'empty', domain: '关账期间', prerequisite: '尚未创建关账期间；点右上角“创建期间”，选择店铺和月份。' }}
        />
      </Card>
    </div>
  )
}
