import { useCallback, useMemo, useState } from 'react'
import { Alert, Button, Card, Form, Input, InputNumber, Select, Space } from 'antd'
import {
  FIRST_MILE_METHOD_LABEL,
  FIRST_MILE_METHODS,
  PRICING_CATEGORIES,
  PRICING_CATEGORY_LABEL,
  type PricingEstimateView,
  type PricingRecordList,
  type PricingRecordRow,
  type PricingScenario,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { PageHeader, PagedGrid, moneyColumn, percentColumn, textColumn, type PageFetcher } from '../../components'
import { useApiQuery } from '../../query/api-query'
import type { ScopeOptions } from '../../shell/ScopeBar'

// 新品定价试算（P6-29，16 章第 10 节）：采购成本、头程、尺寸重量、售价与品类。未上架也可以算。
// 有参考 ASIN 且店铺已授权时，服务端会再排队调用费用预估接口；没有权限时页面直接写出原因。

type FormValues = {
  purchaseCost: number
  method: (typeof FIRST_MILE_METHODS)[number]
  unitPrice?: number
  lengthCm: number
  widthCm: number
  heightCm: number
  weightG: number
  category: (typeof PRICING_CATEGORIES)[number]
  prices: string
  referenceAsin?: string
  storeId?: string
}

const scenarioColumns = [
  moneyColumn<PricingScenario>('售价', 'price', { currency: 'USD', digits: 2 }),
  moneyColumn<PricingScenario>('佣金', 'referralFee', { currency: 'USD', digits: 2 }),
  moneyColumn<PricingScenario>('配送费', 'fulfillmentFee', { currency: 'USD', digits: 2 }),
  moneyColumn<PricingScenario>('头程', 'firstMileFee', { currency: 'USD', digits: 2 }),
  moneyColumn<PricingScenario>('利润', 'profit', { currency: 'USD', digits: 2 }),
  percentColumn<PricingScenario>('毛利率', 'margin', { digits: 1 }),
  percentColumn<PricingScenario>('ROI', 'roi', { digits: 1 }),
  textColumn<PricingScenario>('费用来源', 'feeSource', { valueFormatter: params => (params.value === 'AMAZON' ? '费用预估接口' : '模型估算') }),
]

export default function PricingCalculatorPage() {
  const stores = useApiQuery<ScopeOptions>({ domain: 'reference', path: '/scope/options', scoped: false })
  const [form] = Form.useForm<FormValues>()
  const [result, setResult] = useState<PricingEstimateView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [recordVersion, setRecordVersion] = useState(0)
  const [recordName, setRecordName] = useState('')

  const submit = async () => {
    const values = await form.validateFields()
    const prices = values.prices
      .split(/[,，\s]+/)
      .map(item => Number(item))
      .filter(item => item > 0)
    setBusy(true)
    try {
      const data = await apiFetch<PricingEstimateView>('/tools/pricing-calculator/estimate', {
        method: 'POST',
        body: JSON.stringify({
          purchaseCost: values.purchaseCost,
          firstMile: { method: values.method, unitPrice: values.unitPrice ?? 0 },
          lengthCm: values.lengthCm,
          widthCm: values.widthCm,
          heightCm: values.heightCm,
          weightG: values.weightG,
          category: values.category,
          prices,
          referenceAsin: values.referenceAsin?.trim() || undefined,
          storeId: values.storeId || undefined,
        }),
      })
      setResult(data)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '试算失败')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!result?.canSave) return
    const name = recordName.trim()
    setBusy(true)
    try {
      await apiFetch('/tools/pricing-calculator/records', { method: 'POST', body: JSON.stringify({ id: result.id, name: name || undefined }) })
      setResult({ ...result, canSave: false, saved: true, name: name || result.name })
      setRecordVersion(version => version + 1)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const scenarios = useMemo(() => result?.result.scenarios ?? [], [result])
  const fetchScenarios = useCallback<PageFetcher<PricingScenario>>(
    async ({ page, pageSize }) => {
      const start = (page - 1) * pageSize
      return { items: scenarios.slice(start, start + pageSize), total: scenarios.length }
    },
    [scenarios],
  )
  const fetchRecords = useCallback<PageFetcher<PricingRecordRow>>(async ({ page, pageSize, signal }) => {
    const response = await apiFetch<PricingRecordList>(`/tools/pricing-calculator/records?page=${page}&pageSize=${pageSize}`, { signal })
    return { items: response.items, total: response.total }
  }, [])

  return (
    <div data-testid="pricing-calculator-page">
      <PageHeader title="新品定价试算" description="未上架的新品也可以试算。没有参考 ASIN 时按公开费率表估算，并标明模型估算。" />
      <Card size="small">
        <Form form={form} layout="vertical" initialValues={{ method: 'NONE', category: 'STANDARD', prices: '20, 25', purchaseCost: 5, lengthCm: 20, widthCm: 15, heightCm: 2, weightG: 200 }}>
          <Space wrap size={12}>
            <Form.Item name="purchaseCost" label="采购成本（美元）" rules={[{ required: true }]}>
              <InputNumber min={0} aria-label="采购成本" />
            </Form.Item>
            <Form.Item name="method" label="头程计费方式">
              <Select aria-label="头程计费方式" style={{ width: 140 }} options={FIRST_MILE_METHODS.map(value => ({ value, label: FIRST_MILE_METHOD_LABEL[value] }))} />
            </Form.Item>
            <Form.Item name="unitPrice" label="头程单价（美元）">
              <InputNumber min={0} aria-label="头程单价" />
            </Form.Item>
            <Form.Item name="lengthCm" label="长（厘米）" rules={[{ required: true }]}>
              <InputNumber min={0.1} aria-label="长度厘米" />
            </Form.Item>
            <Form.Item name="widthCm" label="宽（厘米）" rules={[{ required: true }]}>
              <InputNumber min={0.1} aria-label="宽度厘米" />
            </Form.Item>
            <Form.Item name="heightCm" label="高（厘米）" rules={[{ required: true }]}>
              <InputNumber min={0.1} aria-label="高度厘米" />
            </Form.Item>
            <Form.Item name="weightG" label="重量（克）" rules={[{ required: true }]}>
              <InputNumber min={1} aria-label="重量克" />
            </Form.Item>
            <Form.Item name="category" label="品类">
              <Select aria-label="品类" style={{ width: 180 }} options={PRICING_CATEGORIES.map(value => ({ value, label: PRICING_CATEGORY_LABEL[value] }))} />
            </Form.Item>
            <Form.Item name="prices" label="售价（美元，多个用逗号分隔）" rules={[{ required: true }]}>
              <Input aria-label="比较售价" style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="referenceAsin" label="参考 ASIN（可选）">
              <Input aria-label="参考 ASIN" maxLength={10} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="storeId" label="试算店铺（可选）">
              <Select
                aria-label="试算店铺"
                allowClear
                style={{ width: 180 }}
                options={(stores.data?.stores ?? []).map(store => ({ value: store.id, label: store.name }))}
                placeholder="不选则只按费率表"
              />
            </Form.Item>
          </Space>
          <Button type="primary" loading={busy} onClick={() => void submit()}>
            计算利润
          </Button>
        </Form>
      </Card>
      {error ? <Alert type="error" showIcon style={{ marginTop: 8 }} message={error} /> : null}
      {result ? (
        <Alert
          type={result.result.amazon.state === 'NO_PERMISSION' ? 'warning' : 'info'}
          showIcon
          style={{ marginTop: 8 }}
          message={result.reused ? `24 小时内复用了同样参数的结果。${result.result.amazon.message}` : result.result.amazon.message}
          description={`${result.result.tierLabel} · ${result.result.estimateNote}`}
        />
      ) : null}
      <Card size="small" title="售价比较" style={{ marginTop: 8 }}>
        <PagedGrid<PricingScenario>
          gridId="tools.pricing-calculator-scenarios"
          columns={scenarioColumns}
          fetchPage={fetchScenarios}
          getRowId={row => String(row.price)}
          resetKey={result ? `${result.id}:${result.estimatedAt}` : 'none'}
          emptyState={{ kind: 'empty', domain: '试算', prerequisite: '填写成本、尺寸和至少一个售价后计算' }}
          height={280}
        />
        {result?.canSave ? (
          <Space style={{ marginTop: 8 }}>
            <Input aria-label="试算名称" placeholder="名称（可选）" style={{ width: 200 }} value={recordName} onChange={event => setRecordName(event.target.value)} />
            <Button onClick={() => void save()} loading={busy}>
              保存这条试算
            </Button>
          </Space>
        ) : null}
      </Card>
      <Card size="small" title="我保存的试算" style={{ marginTop: 8 }}>
        <PagedGrid<PricingRecordRow>
          gridId="tools.pricing-calculator-records"
          columns={[
            textColumn<PricingRecordRow>('名称', 'name'),
            moneyColumn<PricingRecordRow>('售价', 'price', { currency: 'USD', digits: 2 }),
            moneyColumn<PricingRecordRow>('利润', 'profit', { currency: 'USD', digits: 2 }),
            percentColumn<PricingRecordRow>('毛利率', 'margin', { digits: 1 }),
            textColumn<PricingRecordRow>('费用预估', 'amazonState', {
              valueFormatter: params => (params.value === 'NO_PERMISSION' ? '没有费用预估权限' : params.value === 'OK' ? '接口已返回' : params.value === 'QUEUED' ? '排队中' : '费率表'),
            }),
          ]}
          fetchPage={fetchRecords}
          getRowId={row => row.id}
          resetKey={String(recordVersion)}
          emptyState={{ kind: 'empty', domain: '试算记录', prerequisite: '还没有保存过试算' }}
          height={280}
        />
      </Card>
    </div>
  )
}
