import { useCallback, useMemo, useState } from 'react'
import { Alert, Card, Space, Tag } from 'antd'
import {
  ESTIMATED_MODE_LABEL,
  ESTIMATED_PERIOD_LABEL,
  ESTIMATED_SCOPE_LABEL,
  ESTIMATED_STATUS_LABEL,
  valueText,
  type EstimatedFeeItemOption,
  type EstimatedFeeRow,
  type EstimatedFeeStoreOption,
  type EstimatedFeesResponse,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { EstimateTag, FormAction, PageHeader, PagedGrid, renderColumn, type ErpColDef, type PageFetcher } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { ExportFeesButton, FEE_GUARD, FeeFields, feeBodyOf, feeFormValues, ImportFeesAction } from './estimated-fees-parts'

// 预估与自定义费用（P6-20，16 章第 7 节）：没有实际账单之前先按预算或比例估算费用（站外推广、服务费、品类佣金预估等），以“估算”计入利润。
// 规则表一页一页读取；录入、修改、删除、导入需要 finance.estimatedfee.write 且数据范围为全部店铺。实际费用出账后对应期间的预估自动冲销，不会重复计入。

export default function EstimatedFeesPage() {
  const [items, setItems] = useState<EstimatedFeeItemOption[]>([])
  const [stores, setStores] = useState<EstimatedFeeStoreOption[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [summary, setSummary] = useState<EstimatedFeesResponse['summary'] | null>(null)
  const [tick, setTick] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const refresh = useCallback(() => setTick(current => current + 1), [])

  const fetchRows = useCallback<PageFetcher<EstimatedFeeRow>>(async ({ page, pageSize, signal }) => {
    try {
      const response = await apiFetch<EstimatedFeesResponse & { page: number; pageSize: number }>(`/finance/estimated-fees?page=${page}&pageSize=${pageSize}`, { signal })
      if (page === 1) {
        setItems(response.items)
        setStores(response.stores)
        setNotes(response.notes)
        setSummary(response.summary)
      }
      setLoadError(null)
      return { items: response.rows, total: response.total }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '读取失败')
      throw error
    }
  }, [])

  const columns = useMemo<ErpColDef<EstimatedFeeRow>[]>(
    () => [
      renderColumn<EstimatedFeeRow>('费用项', 'itemName', row => <span title={row.itemPath}>{row.itemPath || row.itemName}</span>, { group: '规则', pin: 'left', width: 260, sortable: false }),
      renderColumn<EstimatedFeeRow>('范围', 'scopeName', row => `${ESTIMATED_SCOPE_LABEL[row.scopeType]}：${row.scopeName}`, { group: '规则', width: 220, sortable: false }),
      renderColumn<EstimatedFeeRow>(
        '方式与金额',
        'value',
        row => (
          <Space size={4}>
            <span className="erp-num">{valueText(row.mode, row.value, row.period)}</span>
            <Muted>{`${ESTIMATED_MODE_LABEL[row.mode]}${row.mode === 'FIXED' ? ` · ${ESTIMATED_PERIOD_LABEL[row.period]}` : ''}`}</Muted>
          </Space>
        ),
        { group: '规则', width: 260, sortable: false },
      ),
      renderColumn<EstimatedFeeRow>('生效区间', 'from', row => <span className="erp-num">{`${row.from} 至 ${row.to ?? '长期'}`}</span>, { group: '规则', width: 220, sortable: false }),
      renderColumn<EstimatedFeeRow>(
        '状态',
        'status',
        row => (
          <Tag color={row.status === 'ACTIVE' ? 'success' : 'default'} bordered={false}>
            {ESTIMATED_STATUS_LABEL[row.status]}
          </Tag>
        ),
        { group: '规则', width: 90, sortable: false },
      ),
      renderColumn<EstimatedFeeRow>('备注', 'note', row => row.note ?? <Muted>—</Muted>, { group: '规则', width: 200, sortable: false }),
      renderColumn<EstimatedFeeRow>('版本', 'version', row => <span className="erp-num">{row.version}</span>, { group: '规则', width: 70, sortable: false }),
      renderColumn<EstimatedFeeRow>(
        '操作',
        'actions',
        row => (
          <Space size={4}>
            <FormAction
              label="修改"
              title={`修改预估费用：${row.itemName}`}
              okText="保存"
              guard={FEE_GUARD}
              width={540}
              buttonProps={{ size: 'small' }}
              initialValues={feeFormValues(row)}
              description="整条覆盖保存；别人先改过会提示刷新。保存后在利润日表下一次重算后生效。"
              successText="规则已保存"
              onSubmit={async values => apiFetch('/finance/estimated-fees', { method: 'PUT', body: JSON.stringify({ id: row.id, version: row.version, ...feeBodyOf(values) }) })}
              onDone={refresh}
            >
              <FeeFields items={items} stores={stores} />
            </FormAction>
            <FormAction
              label="删除"
              title={`删除预估费用：${row.itemName}`}
              okText="删除"
              danger
              guard={FEE_GUARD}
              buttonProps={{ size: 'small' }}
              description="删除后，下一次利润日表重算不再计入这条估算；已关账的期间不受影响。"
              successText="规则已删除"
              onSubmit={async () => apiFetch(`/finance/estimated-fees?id=${encodeURIComponent(row.id)}&version=${row.version}`, { method: 'DELETE' })}
              onDone={refresh}
            />
          </Space>
        ),
        { group: '操作', pin: 'right', width: 150, sortable: false },
      ),
    ],
    [items, stores, refresh],
  )

  return (
    <div data-testid="estimated-fees-page">
      <PageHeader
        title="预估与自定义费用"
        description="实际账单还没出来的费用，先按预算或比例估算并计入利润；实际费用出账后对应期间的预估自动冲销，不重复。"
        actions={
          <Space wrap>
            <EstimateTag method="按规则逐日生成估算费用并计入对应利润项目，利润日表那一行标“含估算”" />
            <ExportFeesButton />
            <ImportFeesAction onDone={refresh} />
            <FormAction
              label="新建规则"
              title="新建预估费用规则"
              okText="新建"
              guard={FEE_GUARD}
              width={540}
              buttonProps={{ type: 'primary' }}
              initialValues={{ scopeType: 'STORE', mode: 'FIXED', period: 'MONTHLY', status: 'ACTIVE', from: new Date().toISOString().slice(0, 10) }}
              description="金额按美元；估算只计到今天为止的日子。"
              successText="规则已新建"
              onSubmit={async values => apiFetch('/finance/estimated-fees', { method: 'POST', body: JSON.stringify(feeBodyOf(values)) })}
              onDone={refresh}
            >
              <FeeFields items={items} stores={stores} />
            </FormAction>
          </Space>
        }
      />
      {notes.length > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="estimated-fees-notes"
          message={
            <Space direction="vertical" size={2}>
              {notes.map(note => (
                <span key={note}>{note}</span>
              ))}
            </Space>
          }
        />
      ) : null}
      {loadError ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={loadError} /> : null}
      <Card size="small" title={summary ? `规则（生效 ${summary.active} 条，停用 ${summary.inactive} 条）` : '规则'}>
        <PagedGrid<EstimatedFeeRow>
          gridId="finance.estimatedFees.rules"
          columns={columns}
          fetchPage={fetchRows}
          getRowId={row => row.id}
          resetKey={String(tick)}
          emptyState={{ kind: 'empty', domain: '预估费用', prerequisite: '还没有预估规则：没有实际账单的费用不会进入利润。点右上角“新建规则”开始。' }}
          height={460}
        />
      </Card>
    </div>
  )
}
