import { useCallback, useState } from 'react'
import { Alert, Button, Descriptions, Form, Input, Select, Space } from 'antd'
import {
  ALLOCATION_RULE_BASES,
  ALLOCATION_RULE_BASIS_LABEL,
  ALLOCATION_RULE_LIMITS,
  isMonthText,
  type AllocationFeeItemOption,
  type AllocationPreviewResponse,
  type AllocationPreviewRow,
  type AllocationRuleBasis,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { PagedGrid, renderColumn, RIGHT_ALIGNED, type ErpColDef, type PageFetcher } from '../../components'
import { Muted } from '../inventory/inventory-ui'

// 费用分摊规则页的零件（P6-19）：手动比例文本的解析与回写、规则表单项、分摊预览区。

export const BASIS_OPTIONS = ALLOCATION_RULE_BASES.map(value => ({ value, label: ALLOCATION_RULE_BASIS_LABEL[value] }))

/** 手动比例文本：每行一个 SKU，后面跟权重，分隔符可以是逗号、冒号、制表符或空格。 */
export function parseManualWeights(text: string | undefined): { weights: Record<string, number> } | { error: string } {
  const weights: Record<string, number> = {}
  const lines = (text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return { error: '手动比例至少填写一个 SKU' }
  if (lines.length > ALLOCATION_RULE_LIMITS.manualSkuMax) return { error: `手动比例最多 ${ALLOCATION_RULE_LIMITS.manualSkuMax} 个 SKU` }
  for (const [index, line] of lines.entries()) {
    const match = /^(.+?)[\s,，:：\t]+(\d+(?:\.\d+)?)$/.exec(line)
    if (!match) return { error: `第 ${index + 1} 行格式不对，应为“SKU 权重”，例如 SKU-A 3` }
    const sku = (match[1] as string).trim()
    const weight = Number(match[2])
    if (!(weight > 0)) return { error: `第 ${index + 1} 行（${sku}）的权重必须大于 0` }
    if (sku in weights) return { error: `第 ${index + 1} 行：SKU ${sku} 重复` }
    weights[sku] = weight
  }
  return { weights }
}

export const manualWeightsText = (weights: Record<string, number> | null): string =>
  Object.entries(weights ?? {})
    .map(([sku, weight]) => `${sku} ${weight}`)
    .join('\n')

/** 把表单值转成接口的 basis 与 manualWeights；手动比例解析失败抛错（表单提交会显示这条原因）。 */
export function ruleBodyOf(values: Record<string, unknown>): { basis: AllocationRuleBasis; manualWeights?: Record<string, number> } {
  const basis = values.basis as AllocationRuleBasis
  if (basis !== 'MANUAL') return { basis }
  const parsed = parseManualWeights(typeof values.manualText === 'string' ? values.manualText : undefined)
  if ('error' in parsed) throw new Error(parsed.error)
  return { basis, manualWeights: parsed.weights }
}

/** 依据与手动比例两个表单项（新建与修改共用）。 */
export function BasisFields() {
  const basis = Form.useWatch('basis')
  return (
    <>
      <Form.Item name="basis" label="分摊依据" rules={[{ required: true, message: '请选择分摊依据' }]}>
        <Select options={BASIS_OPTIONS} data-testid="allocation-basis" />
      </Form.Item>
      {basis === 'MANUAL' ? (
        <Form.Item name="manualText" label="手动比例" extra="每行一个 SKU 和权重，例如：SKU-A 3。按权重占比分摊，不看销售。" rules={[{ required: true, message: '请填写各 SKU 的权重' }]}>
          <Input.TextArea rows={6} autoComplete="off" placeholder={'SKU-A 3\nSKU-B 1'} />
        </Form.Item>
      ) : null}
    </>
  )
}

const money = (value: number) => <span className="erp-num">{value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6, signDisplay: value < 0 ? 'always' : 'auto' })}</span>
const percent = (value: number) => <span className="erp-num">{`${(value * 100).toFixed(2)}%`}</span>

const previewColumns: ErpColDef<AllocationPreviewRow>[] = [
  renderColumn<AllocationPreviewRow>('SKU', 'sku', row => row.sku, { group: '商品', pin: 'left', width: 220, sortable: false }),
  renderColumn<AllocationPreviewRow>('占比', 'share', row => percent(row.share), { group: '新规则', width: 100, sortable: false, ...RIGHT_ALIGNED }),
  renderColumn<AllocationPreviewRow>('分到的金额（美元）', 'amount', row => money(row.amount), { group: '新规则', width: 170, sortable: false, ...RIGHT_ALIGNED }),
  renderColumn<AllocationPreviewRow>('当前规则下（美元）', 'currentAmount', row => money(row.currentAmount), { group: '对比', width: 170, sortable: false, ...RIGHT_ALIGNED }),
  renderColumn<AllocationPreviewRow>('差异（美元）', 'diff', row => money(row.diff), { group: '对比', width: 150, sortable: false, ...RIGHT_ALIGNED }),
]

interface PreviewProps {
  feeItems: AllocationFeeItemOption[]
}

/** 分摊预览：选费用项、月份、依据，看这个月按新规则分摊的结果与当前规则的差异；不保存、不改任何数字。 */
export function PreviewSection({ feeItems }: PreviewProps) {
  const [form] = Form.useForm()
  const [result, setResult] = useState<AllocationPreviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)

  const run = useCallback(async () => {
    setError(null)
    try {
      const values = await form.validateFields()
      const rule = ruleBodyOf(values)
      setBusy(true)
      const response = await apiFetch<AllocationPreviewResponse>('/finance/allocation-rules/preview', {
        method: 'POST',
        body: JSON.stringify({ month: values.month, rule: { feeItemId: values.feeItemId, ...rule } }),
      })
      setResult(response)
      setTick(current => current + 1)
    } catch (caught) {
      if ((caught as { errorFields?: unknown }).errorFields) return
      setResult(null)
      setError(caught instanceof Error ? caught.message : '预览失败')
    } finally {
      setBusy(false)
    }
  }, [form])

  const fetchRows = useCallback<PageFetcher<AllocationPreviewRow>>(
    async ({ page, pageSize }) => {
      const rows = result?.rows ?? []
      return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length }
    },
    [result],
  )

  return (
    <div data-testid="allocation-preview">
      <Form form={form} layout="inline" initialValues={{ month: new Date().toISOString().slice(0, 7), basis: 'SALES_AMOUNT' }} style={{ rowGap: 8, marginBottom: 8 }}>
        <Form.Item name="feeItemId" label="费用项" rules={[{ required: true, message: '请选择费用项' }]}>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 260 }}
            placeholder="选择费用项"
            options={feeItems.map(item => ({ value: item.id, label: item.path }))}
            data-testid="allocation-preview-item"
          />
        </Form.Item>
        <Form.Item
          name="month"
          label="月份"
          rules={[{ required: true, validator: async (_, value) => (isMonthText(String(value ?? '')) ? undefined : Promise.reject(new Error('月份格式应为 YYYY-MM'))) }]}
        >
          <Input style={{ width: 110 }} autoComplete="off" placeholder="YYYY-MM" />
        </Form.Item>
        <BasisFields />
        <Form.Item>
          <Button type="primary" loading={busy} onClick={() => void run()}>
            预览
          </Button>
        </Form.Item>
      </Form>
      {error ? <Alert type="error" showIcon style={{ marginBottom: 8 }} message={error} data-testid="allocation-preview-error" /> : null}
      {result ? (
        <>
          <Descriptions size="small" column={4} bordered style={{ marginBottom: 8 }} data-testid="allocation-preview-summary">
            <Descriptions.Item label="费用项">{result.feeItemName}</Descriptions.Item>
            <Descriptions.Item label="该月店铺级费用（美元）">{money(result.totalAmount)}</Descriptions.Item>
            <Descriptions.Item label="分摊到 SKU（美元）">{money(result.allocatedAmount)}</Descriptions.Item>
            <Descriptions.Item label="留在店铺级（美元）">{money(result.unallocatedAmount)}</Descriptions.Item>
            <Descriptions.Item label="新依据">{ALLOCATION_RULE_BASIS_LABEL[result.basis]}</Descriptions.Item>
            <Descriptions.Item label="当前生效依据">{result.currentBasis ? ALLOCATION_RULE_BASIS_LABEL[result.currentBasis] : '没有规则（不分摊）'}</Descriptions.Item>
            <Descriptions.Item label="期间状态">{result.locked ? '已关账' : '未关账'}</Descriptions.Item>
            <Descriptions.Item label="明细行数">
              {result.rows.length}
              {result.truncated ? '（只显示金额最大的部分）' : ''}
            </Descriptions.Item>
          </Descriptions>
          <Space direction="vertical" size={2} style={{ marginBottom: 8 }} data-testid="allocation-preview-notes">
            {result.notes.map(note => (
              <Muted key={note}>{note}</Muted>
            ))}
          </Space>
          <PagedGrid<AllocationPreviewRow>
            gridId="finance.allocationRules.preview"
            columns={previewColumns}
            fetchPage={fetchRows}
            getRowId={row => `${row.sellerAccountId}|${row.sku}`}
            resetKey={String(tick)}
            emptyState={{ kind: 'empty', domain: '分摊结果', prerequisite: '这个月没有映射到该费用项的店铺级费用，或没有可用的权重。' }}
            height={360}
          />
        </>
      ) : null}
    </div>
  )
}
