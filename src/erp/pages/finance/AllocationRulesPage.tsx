import { useCallback, useMemo, useState } from 'react'
import { Alert, Card, Form, Input, Select, Space, Tabs, Tag } from 'antd'
import { ALLOCATION_RULE_WRITE, isMonthText, type AllocationFeeItemOption, type AllocationRuleRow, type AllocationRulesResponse } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PageHeader, PagedGrid, renderColumn, type ErpColDef, type PageFetcher } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { BasisFields, manualWeightsText, PreviewSection, ruleBodyOf } from './allocation-rules-parts'

// 费用分摊规则（P6-19，16 章第 7 节）：店铺级费用（订阅费、仓储费、移除费、广告发票差额等）按费用项选分摊依据，按月生效。
// 规则表一页一页读取；新建与修改需要 finance.policy.write；已关账月份的规则不能改。新规则在利润日表下一次重算后生效，分摊只改归属、不改总额。

const GUARD = { permission: ALLOCATION_RULE_WRITE } as const

export default function AllocationRulesPage() {
  const [feeItems, setFeeItems] = useState<AllocationFeeItemOption[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [tick, setTick] = useState(0)
  const [tab, setTab] = useState<'rules' | 'preview'>('rules')
  const [loadError, setLoadError] = useState<string | null>(null)
  const refresh = useCallback(() => setTick(current => current + 1), [])

  const fetchRules = useCallback<PageFetcher<AllocationRuleRow>>(async ({ page, pageSize, signal }) => {
    try {
      const response = await apiFetch<AllocationRulesResponse & { page: number; pageSize: number }>(`/finance/allocation-rules?page=${page}&pageSize=${pageSize}`, { signal })
      if (page === 1) {
        setFeeItems(response.feeItems)
        setNotes(response.notes)
      }
      setLoadError(null)
      return { items: response.rows, total: response.total }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '读取失败')
      throw error
    }
  }, [])

  const columns = useMemo<ErpColDef<AllocationRuleRow>[]>(
    () => [
      renderColumn<AllocationRuleRow>('费用项', 'feeItemName', row => <span title={row.feeItemPath}>{row.feeItemPath || row.feeItemName}</span>, {
        group: '规则',
        pin: 'left',
        width: 280,
        sortable: false,
      }),
      renderColumn<AllocationRuleRow>(
        '分摊依据',
        'basisLabel',
        row => (
          <Space size={4}>
            <span>{row.basisLabel}</span>
            {row.manualWeights ? <Muted>{`${Object.keys(row.manualWeights).length} 个 SKU`}</Muted> : null}
          </Space>
        ),
        { group: '规则', width: 220, sortable: false },
      ),
      renderColumn<AllocationRuleRow>('生效月', 'effectiveMonth', row => <span className="erp-num">{row.effectiveMonth}</span>, { group: '规则', width: 110, sortable: false }),
      renderColumn<AllocationRuleRow>('版本', 'version', row => <span className="erp-num">{row.version}</span>, { group: '规则', width: 80, sortable: false }),
      renderColumn<AllocationRuleRow>(
        '状态',
        'locked',
        row =>
          row.locked ? (
            <Tag color="default" bordered={false}>
              已关账（不能改）
            </Tag>
          ) : (
            <Tag color="success" bordered={false}>
              可修改
            </Tag>
          ),
        { group: '规则', width: 140, sortable: false },
      ),
      renderColumn<AllocationRuleRow>(
        '操作',
        'actions',
        row =>
          row.locked ? (
            <Muted>先重开关账</Muted>
          ) : (
            <FormAction
              label="修改"
              title={`修改分摊依据：${row.feeItemName}（${row.effectiveMonth} 起）`}
              okText="保存"
              guard={GUARD}
              width={520}
              buttonProps={{ size: 'small' }}
              initialValues={{ basis: row.basis, manualText: manualWeightsText(row.manualWeights) }}
              description="费用项与生效月不能改；要换月份请新建一条。保存后在利润日表下一次重算后生效。"
              successText="规则已保存"
              onSubmit={async values => apiFetch('/finance/allocation-rules', { method: 'PUT', body: JSON.stringify({ id: row.id, version: row.version, ...ruleBodyOf(values) }) })}
              onDone={refresh}
            >
              <BasisFields />
            </FormAction>
          ),
        { group: '操作', pin: 'right', width: 110, sortable: false },
      ),
    ],
    [refresh],
  )

  return (
    <div data-testid="allocation-rules-page">
      <PageHeader title="费用分摊规则" description="没有 SKU 的店铺级费用按费用项选分摊依据，按月生效。分摊只改变费用归属，不改变总额，店铺总利润不变。" />
      {notes.length > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="allocation-rules-notes"
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
      <Card size="small">
        <Tabs
          activeKey={tab}
          onChange={key => setTab(key as typeof tab)}
          tabBarExtraContent={
            <FormAction
              label="新建规则"
              title="新建分摊规则"
              okText="新建"
              guard={GUARD}
              width={520}
              buttonProps={{ type: 'primary' }}
              initialValues={{ basis: 'SALES_AMOUNT', effectiveMonth: new Date().toISOString().slice(0, 7) }}
              description="同一费用项同一个月只能有一条；每个月取生效月不晚于它的最近一条规则。"
              successText="规则已新建"
              onSubmit={async values =>
                apiFetch('/finance/allocation-rules', {
                  method: 'POST',
                  body: JSON.stringify({ feeItemId: values.feeItemId, effectiveMonth: String(values.effectiveMonth).trim(), ...ruleBodyOf(values) }),
                })
              }
              onDone={refresh}
            >
              <Form.Item name="feeItemId" label="费用项" rules={[{ required: true, message: '请选择费用项' }]} extra="只列出能接收交易明细的费用类项目；括号里是近 90 天没有 SKU 的费用笔数。">
                <Select showSearch optionFilterProp="label" placeholder="选择费用项" options={feeItems.map(item => ({ value: item.id, label: `${item.path}（${item.storeLevelLines90d}）` }))} />
              </Form.Item>
              <Form.Item
                name="effectiveMonth"
                label="生效月"
                rules={[{ required: true, validator: async (_, value) => (isMonthText(String(value ?? '').trim()) ? undefined : Promise.reject(new Error('月份格式应为 YYYY-MM'))) }]}
              >
                <Input autoComplete="off" placeholder="YYYY-MM" />
              </Form.Item>
              <BasisFields />
            </FormAction>
          }
          items={[
            { key: 'rules', label: '规则' },
            { key: 'preview', label: '分摊预览' },
          ]}
        />
        {tab === 'rules' ? (
          <PagedGrid<AllocationRuleRow>
            gridId="finance.allocationRules.rules"
            columns={columns}
            fetchPage={fetchRules}
            getRowId={row => row.id}
            resetKey={String(tick)}
            emptyState={{ kind: 'empty', domain: '分摊规则', prerequisite: '还没有配置规则：店铺级费用会留在店铺级行，不分摊到 SKU。点右上角“新建规则”开始。' }}
            height={460}
          />
        ) : (
          <PreviewSection feeItems={feeItems} />
        )}
      </Card>
    </div>
  )
}
