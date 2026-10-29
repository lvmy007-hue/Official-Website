import { useEffect, useState } from 'react'
import { Alert, Button, Descriptions, Drawer, Form, Input, InputNumber, Space } from 'antd'
import { PRICING_PRICE_WRITE, type GuardrailLimits, type ListingRunSubmitResponse, type PriceChangeSource, type PriceWriteSubmitResponse, type PricingWriteStatuses } from '@nova/api-contracts'
import { ActionGuard } from '../../components'
import { formatMoney, formatPercent } from '../../format'
import { useApiMutation } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { RunSummary, useListingRun } from '../listings/ListingRunPanel'
import { guardOf, priceInputIssue } from './pricing-state'

// 修改价格（P4-11）：填新价格 → “校验预览”（亚马逊只检查、不修改）→ 通过后才能“提交改价”。
// 提交的价格必须与校验过的完全一致，预览 30 分钟内有效（服务端核对）；改了价格要重新校验。
// 价格护栏由服务端再核一遍：超出最低价、最高价、最低利润率或单次调幅上限会被拒绝并写明原因。
// 两步都只是“已受理”，结果以操作记录里的状态为准，不做假成功。

export interface PriceChangeTarget {
  storeId: string
  sku: string
  asin: string
  title: string
  currency: string
  price: number | null
  expectedPrice: number | null
  limits: GuardrailLimits | null
}

/** 来自规则建议的改价：带建议记录编号与建议价，服务端会核对价格与建议一致。 */
export interface RuleSuggestion {
  ruleRunId: string
  price: number
  source: PriceChangeSource
}

type Body = Record<string, unknown>
const pathOf = (body: Body) => `/pricing/${encodeURIComponent(String(body.sku))}`

export function limitsText(limits: GuardrailLimits | null, currency: string): string {
  if (!limits) return '没有设置护栏'
  const parts = [
    limits.minPrice === null ? null : `最低价 ${formatMoney(limits.minPrice, currency, { digits: 2 })}`,
    limits.maxPrice === null ? null : `最高价 ${formatMoney(limits.maxPrice, currency, { digits: 2 })}`,
    limits.minMarginPct === null ? null : `利润率不低于 ${formatPercent(limits.minMarginPct, { digits: 0 })}`,
    limits.maxChangePct === null ? null : `单次调幅不超过 ${formatPercent(limits.maxChangePct, { digits: 0 })}`,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join('；') : '没有设置护栏'
}

export function PriceChangeDrawer({
  target,
  suggestion,
  write,
  onClose,
}: {
  target: PriceChangeTarget | null
  suggestion?: RuleSuggestion | null
  write: PricingWriteStatuses | undefined
  onClose: () => void
}) {
  const [price, setPrice] = useState<number | null>(null)
  const [productType, setProductType] = useState('')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [patchId, setPatchId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const preview = useListingRun(previewId)
  const patched = useListingRun(patchId)
  const validate = useApiMutation<Body, PriceWriteSubmitResponse>({ method: 'POST', path: body => `${pathOf(body)}/validate`, invalidate: ['realtime'], silent: true })
  const update = useApiMutation<Body, ListingRunSubmitResponse>({ method: 'PATCH', path: pathOf, invalidate: ['realtime', 'list', 'analytics'], silent: true })

  // 每次打开重新开始：建议价预填，其余留空
  useEffect(() => {
    setPrice(suggestion?.price ?? null)
    setProductType('')
    setPreviewId(null)
    setPatchId(null)
    setError(null)
  }, [target?.sku, target?.storeId, suggestion?.ruleRunId, suggestion?.price])

  const close = () => {
    onClose()
  }
  const problem = price === null ? null : priceInputIssue(price)
  const verdict = preview.data
  const approved = Boolean(verdict && verdict.validation === 'VALID' && verdict.usableUntil)
  const changePct = target?.price && price ? (price - target.price) / target.price : null
  const bodyOf = (extra: Body = {}): Body => ({
    sku: target?.sku,
    storeId: target?.storeId,
    price,
    ...(productType.trim() ? { productType: productType.trim() } : {}),
    ...extra,
  })

  const runValidate = async () => {
    setError(null)
    setPatchId(null)
    try {
      const res = await validate.mutateAsync(bodyOf())
      setPreviewId(res.run.id)
    } catch (failure) {
      const info = describeError(failure)
      setError(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    }
  }

  return (
    <Drawer open={Boolean(target)} onClose={close} width={560} title="修改价格" destroyOnClose data-testid="price-change-drawer">
      {target ? (
        <>
          <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
            <Descriptions.Item label="商品">
              {target.title} · {target.asin || '尚无 ASIN'} · {target.sku}
            </Descriptions.Item>
            <Descriptions.Item label="当前价格">{target.price === null ? '尚无记录' : formatMoney(target.price, target.currency, { digits: 2 })}</Descriptions.Item>
            <Descriptions.Item label="预期获胜价">{target.expectedPrice === null ? '尚无记录' : formatMoney(target.expectedPrice, target.currency, { digits: 2 })}</Descriptions.Item>
            <Descriptions.Item label="价格护栏">{limitsText(target.limits, target.currency)}</Descriptions.Item>
            {suggestion ? <Descriptions.Item label="来源">规则建议（人工确认）：价格必须与建议价一致</Descriptions.Item> : null}
          </Descriptions>
          <Form layout="vertical" requiredMark={false}>
            <Form.Item label={`新价格（${target.currency}）`} validateStatus={problem ? 'error' : undefined} help={problem ?? undefined}>
              <InputNumber
                aria-label="新价格"
                style={{ width: 200 }}
                min={0}
                max={100_000}
                step={0.01}
                precision={2}
                value={price}
                disabled={Boolean(suggestion)}
                onChange={value => {
                  setPrice(typeof value === 'number' ? value : null)
                  setPreviewId(null)
                  setPatchId(null)
                }}
              />
              {changePct !== null ? <span style={{ marginLeft: 8, color: 'rgba(0,0,0,0.45)' }}>较当前 {formatPercent(changePct, { digits: 1, sign: true })}</span> : null}
            </Form.Item>
            <Form.Item label="商品类型（选填，已同步过的商品不用填）">
              <Input aria-label="商品类型" maxLength={80} placeholder="例如 LUGGAGE" value={productType} onChange={event => setProductType(event.target.value.toUpperCase())} />
            </Form.Item>
          </Form>
          {error ? <Alert type="error" showIcon role="alert" style={{ marginBottom: 8 }} message={error} /> : null}
          <Space wrap>
            <Button type="primary" onClick={() => void runValidate()} loading={validate.isPending} disabled={price === null || Boolean(problem)}>
              校验预览
            </Button>
            {approved && verdict && price !== null ? (
              <ActionGuard
                label="提交改价"
                guard={guardOf(PRICING_PRICE_WRITE, write?.update)}
                preview={{
                  title: '确认提交改价',
                  content: (
                    <p>
                      将把 {target.sku} 的价格从 {target.price === null ? '（尚无记录）' : formatMoney(target.price, target.currency, { digits: 2 })} 改为{' '}
                      {formatMoney(price, target.currency, { digits: 2 })}，由后台任务提交亚马逊；提交的价格与刚才校验过的一致。
                    </p>
                  ),
                  confirmText: '确认提交',
                }}
                successText="已交给后台任务提交亚马逊"
                onExecute={async () => {
                  const res = await update.mutateAsync(bodyOf({ previewRunId: verdict.id, ...(suggestion ? { ruleRunId: suggestion.ruleRunId } : {}) }))
                  setPatchId(res.run.id)
                }}
                buttonProps={{ type: 'primary' }}
              />
            ) : null}
          </Space>
          {preview.data ? (
            <div style={{ marginTop: 12 }}>
              <strong>校验预览</strong>
              <RunSummary run={preview.data} />
            </div>
          ) : null}
          {patched.data ? (
            <div style={{ marginTop: 12 }}>
              <strong>改价结果</strong>
              <RunSummary run={patched.data} />
            </div>
          ) : null}
        </>
      ) : null}
    </Drawer>
  )
}
