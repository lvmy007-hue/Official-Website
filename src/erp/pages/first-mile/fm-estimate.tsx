import { useMemo, useState } from 'react'
import { Alert, Button, Descriptions, Form, InputNumber, Modal, Select, Space, Tag, Tooltip, Typography } from 'antd'
import {
  estimateGap,
  isDeviationAbnormal,
  DEVIATION_DEFAULT_PCT,
  permissionDeniedMessage,
  type CarrierListResponse,
  type EstimateResponse,
  type FillItemsResult,
  type FirstMileDetail,
} from '@nova/api-contracts'
import { FormAction } from '../../components'
import { formatNumber } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'
import { money } from '../procurement/procurement-ui'

// 头程预估费用与缺失字段（P6-26，16 章第 5.1 节）：
// - 缺重量或体积的明细在页面顶部提示，并可一次补录（建议值取自商品档案的包装尺寸与重量，只补空着的格子）；
// - “费用与分摊”页签里并列预估、实际、差异三行；差异超过阈值标“异常”；按渠道预估只是试算，点“采用为运单预估”才写回运单。

const WRITE = 'firstmile.write'
const MISSING_LABEL = { WEIGHT: '重量', VOLUME: '体积' } as const

export function MissingFieldsAlert({ detail }: { detail: FirstMileDetail }) {
  const rows = detail.missingFields
  const locked = detail.actions.includes('UNALLOCATE') || Boolean(detail.shipment.outboundAt)
  const write = useApiMutation<{ version: number; rows: Array<Record<string, unknown>> }, FillItemsResult>({
    method: 'POST',
    path: `/first-mile/${encodeURIComponent(detail.shipment.id)}/items/fill`,
    invalidate: ['list'],
    silent: true,
  })
  if (rows.length === 0) return null
  const initial: Record<string, unknown> = {}
  rows.forEach((row, index) => {
    initial[`w${index}`] = row.suggestedWeightKg ?? undefined
    initial[`v${index}`] = row.suggestedVolumeCbm ?? undefined
  })
  return (
    <Alert
      type="warning"
      showIcon
      message={`有 ${rows.length} 个 SKU 缺重量或体积，无法按渠道预估头程费用，也不能按对应口径分摊`}
      description={
        <Space direction="vertical" size={4}>
          <span>{rows.map(row => `${row.sku}（缺${row.missing.map(field => MISSING_LABEL[field]).join('、')}）`).join('；')}</span>
          {locked ? (
            <Muted>已出库或费用已分摊，明细不能再改；要补录请先撤销分摊。</Muted>
          ) : (
            <FormAction
              label="一次补录"
              guard={{ permission: WRITE }}
              title="补录重量与体积"
              description="重量填这一行 SKU 的合计公斤数，体积填合计立方米。已带出的数是按商品档案里的单件包装尺寸与重量乘以数量算的建议值，请核对；留空的格子不会提交。"
              okText="补录"
              successText="已补录"
              width={640}
              buttonProps={{ size: 'small', type: 'primary' }}
              initialValues={initial}
              onSubmit={values =>
                write.mutateAsync({
                  version: detail.shipment.version,
                  rows: rows
                    .map((row, index) => ({
                      sku: row.sku,
                      weightKg: row.missing.includes('WEIGHT') ? (values[`w${index}`] as number | null | undefined) : undefined,
                      volumeCbm: row.missing.includes('VOLUME') ? (values[`v${index}`] as number | null | undefined) : undefined,
                    }))
                    .filter(row => (row.weightKg ?? null) !== null || (row.volumeCbm ?? null) !== null),
                })
              }
            >
              {rows.map((row, index) => (
                <Space key={row.sku} align="start" wrap>
                  <Typography.Text strong style={{ display: 'inline-block', width: 140, paddingTop: 4 }}>
                    {row.sku}
                  </Typography.Text>
                  {row.missing.includes('WEIGHT') ? (
                    <Form.Item name={`w${index}`} label="重量 kg" style={{ marginBottom: 8 }}>
                      <InputNumber aria-label={`${row.sku} 重量`} min={0} style={{ width: 120 }} />
                    </Form.Item>
                  ) : null}
                  {row.missing.includes('VOLUME') ? (
                    <Form.Item name={`v${index}`} label="体积 m³" style={{ marginBottom: 8 }}>
                      <InputNumber aria-label={`${row.sku} 体积`} min={0} style={{ width: 120 }} />
                    </Form.Item>
                  ) : null}
                </Space>
              ))}
            </FormAction>
          )}
        </Space>
      }
      style={{ marginBottom: 4 }}
    />
  )
}

/** 预估 / 实际 / 差异三行；没有费用权限（预估为 undefined）整块不显示。 */
export function EstimatePanel({ detail }: { detail: FirstMileDetail }) {
  const { shipment, qtyCheck } = detail
  const [open, setOpen] = useState(false)
  const { canPermission } = useSession()
  if (shipment.estimatedCost === undefined) return null
  const estimated = shipment.estimatedCost === null ? null : Number(shipment.estimatedCost)
  const actual = shipment.actualCost === undefined || shipment.actualCost === null ? null : Number(shipment.actualCost)
  const gap = estimateGap(estimated, actual)
  const abnormal = isDeviationAbnormal(gap.pct, DEVIATION_DEFAULT_PCT)
  const canWrite = canPermission(WRITE)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Descriptions
        size="small"
        bordered
        column={1}
        title="预估与实际"
        extra={
          <Tooltip title={canWrite ? undefined : permissionDeniedMessage(WRITE)}>
            <span>
              <Button size="small" disabled={!canWrite} onClick={() => setOpen(true)}>
                按渠道预估
              </Button>
            </span>
          </Tooltip>
        }
      >
        <Descriptions.Item label="预估头程费用">
          {money(shipment.estimatedCost, shipment.currency)}
          {shipment.carrierChannelName ? <Typography.Text type="secondary"> 按「{shipment.carrierChannelName}」预估</Typography.Text> : null}
        </Descriptions.Item>
        <Descriptions.Item label="实际头程费用">{money(shipment.actualCost, shipment.currency)}</Descriptions.Item>
        <Descriptions.Item label="差异">
          {gap.diff === null ? (
            <Muted>{estimated === null ? '尚无预估，无法对比' : '尚无实际费用，无法对比'}</Muted>
          ) : (
            <Space>
              <span className="erp-num">{money(String(gap.diff), shipment.currency)}</span>
              {gap.pct === null ? null : <span className="erp-num">{formatNumber(gap.pct, { digits: 1 })}%</span>}
              {abnormal ? <Tag color="error">异常（超过 {DEVIATION_DEFAULT_PCT}%）</Tag> : null}
            </Space>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="已发数量核对">
          <Space direction="vertical" size={0}>
            <Tag color={qtyCheck.state === 'MATCH' ? 'success' : qtyCheck.state === 'MISMATCH' ? 'error' : 'default'} bordered={false} style={{ width: 'fit-content' }}>
              {qtyCheck.state === 'MATCH' ? '一致' : qtyCheck.state === 'MISMATCH' ? '不一致' : qtyCheck.state === 'NOT_LINKED' ? '未关联货件' : '暂不能核对'}
            </Tag>
            <Typography.Text type="secondary">{qtyCheck.note}</Typography.Text>
          </Space>
        </Descriptions.Item>
      </Descriptions>
      {open ? <EstimateModal detail={detail} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

const BLOCK_TEXT = { MISSING_FIELDS: '缺重量或体积', NO_RATE: '没有匹配的报价', NO_CHANNEL: '没有选渠道', CURRENCY_MISMATCH: '币种与运单不一致' } as const

function EstimateModal({ detail, onClose }: { detail: FirstMileDetail; onClose: () => void }) {
  const [channelId, setChannelId] = useState<string | undefined>(detail.shipment.carrierChannelId ?? undefined)
  const [region, setRegion] = useState<string | undefined>()
  const [result, setResult] = useState<EstimateResponse | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const carriers = useApiQuery<CarrierListResponse>({ domain: 'reference', path: '/first-mile/carriers', params: { pageSize: 100 }, scoped: false })
  const path = `/first-mile/${encodeURIComponent(detail.shipment.id)}`
  const estimate = useApiMutation<{ channelId: string; region: string }, EstimateResponse>({ method: 'POST', path: `${path}/estimate`, silent: true })
  const adopt = useApiMutation<Record<string, unknown>, unknown>({ method: 'PATCH', path, invalidate: ['list'], silent: true })
  const channels = useMemo(
    () => (carriers.data?.items ?? []).flatMap(carrier => carrier.channels.filter(channel => channel.status === 'ACTIVE').map(channel => ({ ...channel, label: `${carrier.name} · ${channel.name}` }))),
    [carriers.data],
  )
  const regions = channels.find(channel => channel.id === channelId)?.regions ?? []
  const amount = result?.estimate.state === 'OK' ? result.estimate.amount : null

  const run = async () => {
    if (!channelId || !region) return
    setFailure(null)
    setResult(null)
    try {
      setResult(await estimate.mutateAsync({ channelId, region }))
    } catch (error) {
      setFailure(describeError(error).message)
    }
  }
  const apply = async () => {
    if (!channelId || amount === null || amount === undefined) return
    setFailure(null)
    try {
      await adopt.mutateAsync({ version: detail.shipment.version, carrierChannelId: channelId, estimatedCost: amount })
      onClose()
    } catch (error) {
      setFailure(describeError(error).message)
    }
  }

  return (
    <Modal open title="按渠道预估头程费用" onCancel={onClose} footer={null} width={640} destroyOnClose>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          按运单明细合计的重量与体积算计费重量（实重与体积重取大，按渠道的材积除数和分抛系数折算），再按目的地区与重量段找阶梯单价。这里只是试算，不会改运单。
        </Typography.Text>
        <Space wrap>
          <Select
            aria-label="物流渠道"
            showSearch
            optionFilterProp="label"
            style={{ width: 300 }}
            placeholder="选择物流渠道"
            loading={carriers.isPending}
            value={channelId}
            options={channels.map(channel => ({ value: channel.id, label: channel.label }))}
            onChange={value => {
              setChannelId(value)
              setRegion(undefined)
              setResult(null)
            }}
          />
          <Select
            aria-label="目的地区"
            style={{ width: 180 }}
            placeholder={channelId && regions.length === 0 ? '该渠道尚无报价' : '选择目的地区'}
            disabled={regions.length === 0}
            value={region}
            options={regions.map(item => ({ value: item, label: item }))}
            onChange={value => {
              setRegion(value)
              setResult(null)
            }}
          />
          <Button type="primary" disabled={!channelId || !region} loading={estimate.isPending} onClick={() => void run()}>
            计算预估
          </Button>
        </Space>
        {failure ? <Alert type="error" showIcon role="alert" message={failure} /> : null}
        {result ? (
          result.estimate.state === 'OK' ? (
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="计费重量">
                <span className="erp-num">{formatNumber(result.estimate.chargeableKg ?? 0, { digits: 2 })} 公斤</span>（实重 {formatNumber(result.estimate.actualKg ?? 0, { digits: 2 })}，体积重{' '}
                {formatNumber(result.estimate.volumetricKg ?? 0, { digits: 2 })}）
              </Descriptions.Item>
              <Descriptions.Item label="预估头程费用">
                {amount === null || amount === undefined ? (
                  <Muted>无权查看金额</Muted>
                ) : (
                  <strong className="erp-num">{money(String(amount), result.estimate.currency ?? detail.shipment.currency)}</strong>
                )}
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <Alert type="warning" showIcon message={`不能预估：${result.estimate.block ? BLOCK_TEXT[result.estimate.block] : ''}`} description={result.estimate.reason} />
          )
        ) : null}
        <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" disabled={amount === null || amount === undefined} loading={adopt.isPending} onClick={() => void apply()}>
            采用为运单预估
          </Button>
        </Space>
      </Space>
    </Modal>
  )
}
