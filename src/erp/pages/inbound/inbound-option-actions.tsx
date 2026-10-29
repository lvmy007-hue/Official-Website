import { Alert, Form, Input, Select, Typography } from 'antd'
import {
  INBOUND_LABEL_PAGE_TYPES,
  parseBoxLines,
  type InboundOptionsResponse,
  type InboundOverview,
  type InboundShipmentView,
  type PlacementOptionView,
  type PackingOptionView,
} from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { formatMoney } from '../../format'
import { guardFor, SWITCH, usePlanWrite, versionOf } from './inbound-actions'
import { Countdown } from './inbound-ui'

// 页签里的动作：确认装箱与分仓方案、填写估算与自理成本、导入箱内物品、打印标签、回填追踪号。
// 每个动作先说明将发生什么再提交；方案已过期的确认按钮直接禁用并写明原因。

const expired = (at: string | null) => at !== null && new Date(at).getTime() <= Date.now()
const decimal = { pattern: /^\d+(\.\d{1,4})?$/, message: '填写非负数' }
const numberOrNull = (value: unknown): number | null => (typeof value === 'string' && value.trim() !== '' ? Number(value) : null)

export function ConfirmPackingAction({ overview, option }: { overview: InboundOverview; option: PackingOptionView }) {
  const write = usePlanWrite(overview.plan.id)
  const gone = option.status !== 'OFFERED' || expired(option.expiresAt)
  const guard = guardFor(overview, 'CONFIRM_PACKING', SWITCH.packing)
  return (
    <FormAction
      label="确认这个方案"
      guard={gone ? { ...guard, condition: { ok: false, reason: option.status !== 'OFFERED' ? '这个方案已不可选' : '这个方案已过期，请重新生成' } } : guard}
      title="确认装箱方案"
      description={
        <Alert
          type="warning"
          showIcon
          message={`装箱方案 ${option.packingOptionId}：${option.groups.length} 个装箱组，包装费 ${option.fees === null ? '亚马逊未给出' : formatMoney(option.fees, option.currency)}`}
          description="确认后不能改选其他装箱方案；确认由后台任务提交，计划显示“处理中”直到亚马逊返回。"
        />
      }
      confirmText="我已核对，确认这个装箱方案"
      okText="确认"
      successText="已交给后台任务确认装箱方案"
      onSubmit={() => write.post('/packing-options', { action: 'CONFIRM', optionId: option.packingOptionId, ...versionOf(overview.plan) })}
    />
  )
}

export function ConfirmPlacementAction({ overview, option }: { overview: InboundOverview; option: PlacementOptionView }) {
  const write = usePlanWrite(overview.plan.id)
  const gone = option.status !== 'OFFERED' || expired(option.expiresAt)
  const guard = guardFor(overview, 'CONFIRM_PLACEMENT', SWITCH.placement)
  const fmt = (value: number) => formatMoney(value, option.currency)
  return (
    <FormAction
      label="确认这个方案"
      guard={gone ? { ...guard, condition: { ok: false, reason: option.status !== 'OFFERED' ? '这个方案已不可选' : '这个方案已过期，请重新生成' } } : guard}
      title="确认分仓方案"
      description={
        <Alert
          type="warning"
          showIcon
          message={`分仓方案 ${option.placementOptionId}：${option.shipmentCount} 个货件，分仓费 ${fmt(option.fees)}，折扣 ${fmt(option.discounts)}，预估总成本 ${fmt(option.cost.total)}`}
          description={
            <>
              {option.cost.missing.length > 0 ? <div>总成本依据不完整：{option.cost.missing.join('；')}</div> : null}
              <div>
                有效期：
                <Countdown at={option.expiresAt} />
                。确认后不能改选其他分仓方案。
              </div>
            </>
          }
        />
      }
      confirmText="我已核对，确认这个分仓方案"
      okText="确认"
      successText="已交给后台任务确认分仓方案"
      onSubmit={() => write.post('/placement-options', { action: 'CONFIRM', optionId: option.placementOptionId, ...versionOf(overview.plan) })}
    />
  )
}

/** 填写分仓方案总成本的估算参数（运费单价、断货损失、各运营中心到仓天数）：只改我们这里的数据。 */
export function EstimateAction({ overview, estimate }: { overview: InboundOverview; estimate: InboundOptionsResponse['estimate'] }) {
  const write = usePlanWrite(overview.plan.id)
  const days = Object.entries(estimate?.transitDaysByFc ?? {})
    .map(([fc, value]) => `${fc}=${value}`)
    .join('\n')
  return (
    <FormAction
      label="填写运费与时效估算"
      guard={{ permission: 'inbound.plan.write' }}
      title="分仓方案总成本的估算参数"
      description="总成本 = 分仓费 − 折扣 + 预估运费 + 断货风险成本。没填的项不会被当成 0，页面会列出缺哪些。只保存在我们这里。"
      initialValues={{ freightPerLb: estimate?.freightPerLb ?? '', freightPerShipment: estimate?.freightPerShipment ?? '', dailyStockoutCost: estimate?.dailyStockoutCost ?? '', days }}
      okText="保存"
      successText="已保存估算参数"
      onSubmit={values => {
        const transit: Record<string, number> = {}
        for (const line of String(values.days ?? '').split(/\r?\n/)) {
          const [fc, value] = line.split(/[=,，]/).map(cell => cell.trim())
          if (fc && value && Number.isFinite(Number(value))) transit[fc] = Number(value)
        }
        return write.patch('/costs', {
          ...versionOf(overview.plan),
          estimate: {
            freightPerLb: numberOrNull(values.freightPerLb),
            freightPerShipment: numberOrNull(values.freightPerShipment),
            dailyStockoutCost: numberOrNull(values.dailyStockoutCost),
            transitDaysByFc: transit,
          },
        })
      }}
    >
      <Form.Item label="每磅运费（美元，选填）" name="freightPerLb" rules={[decimal]}>
        <Input aria-label="每磅运费" inputMode="decimal" style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="每个货件的固定运费（美元，选填）" name="freightPerShipment" rules={[decimal]}>
        <Input aria-label="每个货件固定运费" inputMode="decimal" style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="每日断货损失（美元，选填）" name="dailyStockoutCost" rules={[decimal]}>
        <Input aria-label="每日断货损失" inputMode="decimal" style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="各运营中心到仓天数（每行一个，例如 ONT8=2）" name="days">
        <Input.TextArea aria-label="各运营中心到仓天数" rows={4} />
      </Form.Item>
    </FormAction>
  )
}

/** 填写卖家自理的预处理与贴标费用（美国站亚马逊不再提供这两项服务，费用由卖家承担）。 */
export function PrepCostsAction({ overview }: { overview: InboundOverview }) {
  const write = usePlanWrite(overview.plan.id)
  const { costs } = overview
  return (
    <FormAction
      label="填写自理费用"
      guard={{ permission: 'inbound.plan.write' }}
      title="预处理与贴标费用（卖家自理）"
      description="预处理与贴标固定由卖家负责，这里记录你实际花费的费用；留空表示还没有数据，不会按 0 计入合计。"
      initialValues={{ prepCost: costs.prepCost ?? '', labelCost: costs.labelCost ?? '' }}
      okText="保存"
      successText="已保存"
      onSubmit={values => write.patch('/costs', { ...versionOf(overview.plan), prepCost: numberOrNull(values.prepCost), labelCost: numberOrNull(values.labelCost) })}
    >
      <Form.Item label="预处理费用（选填）" name="prepCost" rules={[decimal]}>
        <Input aria-label="预处理费用" inputMode="decimal" style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="贴标费用（选填）" name="labelCost" rules={[decimal]}>
        <Input aria-label="贴标费用" inputMode="decimal" style={{ width: 200 }} />
      </Form.Item>
    </FormAction>
  )
}

function BoxTextField() {
  const form = Form.useFormInstance()
  const text = Form.useWatch('text', form) as string | undefined
  const parsed = parseBoxLines(text ?? '')
  return (
    <>
      <Form.Item
        label="箱内物品（每行一个商品：箱号、SKU、每箱数量、重量(磅)、长、宽、高(英寸)、相同箱数）"
        name="text"
        rules={[
          { required: true, whitespace: true, message: '请粘贴箱内物品' },
          { validator: (_rule, value) => (!value || parsed.errors.length === 0 ? Promise.resolve() : Promise.reject(new Error(`第 ${parsed.errors[0].line} 行：${parsed.errors[0].message}`))) },
        ]}
      >
        <Input.TextArea aria-label="箱内物品" rows={8} placeholder={'BOX-1,SKU-A,10,22,16,12,10,2\nBOX-1,SKU-B,5,22,16,12,10,2'} />
      </Form.Item>
      {text?.trim() ? (
        <Typography.Paragraph type={parsed.errors.length ? 'danger' : 'secondary'} data-testid="box-preview">
          {parsed.errors.length ? `有 ${parsed.errors.length} 行不能导入，修正后才能保存` : `预览：${parsed.boxes.length} 个箱型，共 ${parsed.boxes.reduce((sum, box) => sum + box.quantity, 0)} 箱`}
        </Typography.Paragraph>
      ) : null}
    </>
  )
}

/** 批量导入箱内物品：整体替换现有箱子；只保存在我们这里，提交给亚马逊是单独的动作。 */
export function BoxImportAction({ overview }: { overview: InboundOverview }) {
  const write = usePlanWrite(overview.plan.id)
  if (!overview.actions.SAVE_BOXES.allowed) return null
  return (
    <FormAction
      label="导入箱内物品"
      guard={guardFor(overview, 'SAVE_BOXES', null, false)}
      title="导入箱内物品（替换现有箱子）"
      description={<Alert type="info" showIcon message="同一箱号的多行合并成一个箱子；有任何一行有问题整份不导入。保存后到“箱内物品”页签核对数量，再提交给亚马逊。" />}
      okText="保存"
      successText="已保存箱内物品"
      onSubmit={values => write.put('/boxes', { ...versionOf(overview.plan), boxes: parseBoxLines(String(values.text ?? '')).boxes })}
    >
      <BoxTextField />
    </FormAction>
  )
}

export function LabelPrintAction({ overview, shipments }: { overview: InboundOverview; shipments: Array<{ shipmentId: string }> }) {
  const write = usePlanWrite(overview.plan.id)
  if (!overview.actions.PRINT_LABELS.allowed) return null
  return (
    <FormAction
      label="获取亚马逊箱标签"
      guard={guardFor(overview, 'PRINT_LABELS', null)}
      title="获取亚马逊箱标签"
      description="向亚马逊获取箱标签（PDF）；每个货件一个任务，生成后可下载。获取标签是只读调用，不改变亚马逊上的数据。要在箱标签上追加文字，取到文件后在下面按货件“生成自定义箱标签”（纸张要和模板一致）；商品标签（FNSKU）不用在这里取，直接“生成商品标签（PDF）”。"
      initialValues={{ pageType: 'PackageLabel_Letter_6' }}
      okText="开始获取"
      successText="已交给后台任务获取箱标签"
      buttonProps={{ type: 'primary' }}
      onSubmit={values => write.post('/labels/print-jobs', { kind: 'BOX', pageType: values.pageType, ...(values.shipmentId ? { shipmentId: values.shipmentId } : {}) })}
    >
      <Form.Item label="纸张" name="pageType">
        <Select aria-label="纸张" options={INBOUND_LABEL_PAGE_TYPES.map(value => ({ value, label: value.replace('PackageLabel_', '') }))} />
      </Form.Item>
      <Form.Item label="货件（不选则全部货件）" name="shipmentId">
        <Select allowClear aria-label="货件" options={shipments.map(item => ({ value: item.shipmentId, label: item.shipmentId }))} />
      </Form.Item>
    </FormAction>
  )
}

/** 回填追踪号：小包裹逐箱填写，零担填提单号；承运商记在货件上。 */
export function TrackingAction({ overview, shipment }: { overview: InboundOverview; shipment: InboundShipmentView }) {
  const base = `/inbound/shipments/${encodeURIComponent(shipment.id)}/tracking`
  const patch = useApiMutation<Record<string, unknown>, unknown>({ method: 'PATCH', path: base, invalidate: ['list'], silent: true })
  if (!overview.actions.UPDATE_TRACKING.allowed) return null
  const freight = shipment.shippingMode === 'LTL' || shipment.shippingMode === 'FTL'
  return (
    <FormAction
      label="回填追踪号"
      guard={guardFor(overview, 'UPDATE_TRACKING', SWITCH.transport)}
      title={`回填追踪号：${shipment.shipmentId}`}
      description={<Alert type="info" showIcon message="会把追踪信息提交给亚马逊，由后台任务完成。" />}
      okText="提交"
      successText="已交给后台任务回填追踪号"
      initialValues={{ carrier: shipment.carrier ?? '' }}
      onSubmit={values => {
        const items = String(values.lines ?? '')
          .split(/\r?\n/)
          .map(line => line.split(/[,\t]/).map(cell => cell.trim()))
          .filter(cells => cells[0] && cells[1])
          .map(([boxId, trackingId]) => ({ boxId, trackingId }))
        return patch.mutateAsync({
          version: overview.plan.version,
          ...(String(values.carrier ?? '').trim() ? { carrier: String(values.carrier).trim() } : {}),
          ...(freight ? { billOfLadingNumber: String(values.bol ?? '').trim() || undefined } : { items }),
        })
      }}
    >
      <Form.Item label="承运商（选填）" name="carrier">
        <Input aria-label="承运商" style={{ width: 240 }} maxLength={60} />
      </Form.Item>
      {freight ? (
        <Form.Item label="提单号" name="bol" rules={[{ required: true, whitespace: true, message: '请填写提单号' }]}>
          <Input aria-label="提单号" maxLength={60} />
        </Form.Item>
      ) : (
        <Form.Item label="每个箱子的追踪号（每行：箱号,追踪号）" name="lines" rules={[{ required: true, whitespace: true, message: '请填写追踪号' }]}>
          <Input.TextArea aria-label="追踪号" rows={5} placeholder={'BOX-001,1Z999AA10123456784'} />
        </Form.Item>
      )}
    </FormAction>
  )
}
