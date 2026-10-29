import { Alert, Checkbox, Form, InputNumber, Select, Space } from 'antd'
import {
  BOX_NO_START_MAX,
  ITEM_LABEL_MAX,
  ITEM_LABEL_SIZES,
  ITEM_LABEL_SIZE_SPEC,
  LABEL_EXPORT_PERMISSION,
  LABEL_GENERATE_PERMISSION,
  LABEL_PAPER_SPEC,
  LABEL_SIGN_WARNING,
  type LabelGenerateResponse,
  type LabelPrintStat,
  type LabelTemplateRow,
} from '@nova/api-contracts'
import { FormAction } from '../../../components'
import { useApiMutation } from '../../../query/api-query'
import { useOptionalSession } from '../../../session/session'

// 入仓计划“标签”页签里的两个生成动作（P6-12）：自定义箱标签（在亚马逊箱标签基础上追加文字）与商品标签（FNSKU 条码）。
// 都是本地生成 PDF，不调用亚马逊写接口、不受写入开关控制；要有入仓写入权限和导出权限（文件在导出中心下载）。
// 提交只是创建后台任务；结果以服务端为准（缺亚马逊箱标签文件、缺 FNSKU、数量超限等原因如实显示）。

const DEFAULT_TEMPLATE = '__default__'

/** 本地生成标签的守卫：入仓写入权限；没有导出权限时指出缺的是导出权限。 */
function useGenerateGuard() {
  const session = useOptionalSession()
  const allowed = (permission: string) => session?.canPermission(permission) ?? false
  return { permission: allowed(LABEL_EXPORT_PERMISSION) ? LABEL_GENERATE_PERMISSION : LABEL_EXPORT_PERMISSION }
}

type Generated = (response: LabelGenerateResponse) => void

function TemplateHint({ stat, templates }: { stat: LabelPrintStat; templates: readonly LabelTemplateRow[] }) {
  const form = Form.useFormInstance<{ templateId?: string }>()
  const chosen = Form.useWatch('templateId', form) ?? DEFAULT_TEMPLATE
  const template = chosen === DEFAULT_TEMPLATE ? templates.find(item => item.isDefault) : templates.find(item => item.id === chosen)
  const paper = LABEL_PAPER_SPEC[template?.paper ?? 'A4_4UP']
  const missing = !stat.readyPageTypes.includes(paper.amazonPageType)
  return (
    <>
      <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={LABEL_SIGN_WARNING} />
      {missing ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`还没有取到“${paper.label}”的亚马逊箱标签`}
          description={`自定义箱标签以亚马逊箱标签文件为底：请先点“获取亚马逊箱标签”，货件选 ${stat.shipmentId}，纸张选 ${paper.amazonPageType}，取到后再生成。`}
        />
      ) : null}
    </>
  )
}

export function CustomBoxLabelAction({ stat, templates, onGenerated }: { stat: LabelPrintStat; templates: readonly LabelTemplateRow[]; onGenerated: Generated }) {
  const guard = useGenerateGuard()
  const post = useApiMutation<{ body: Record<string, unknown> }, LabelGenerateResponse>({
    method: 'POST',
    path: () => `/inbound/shipments/${encodeURIComponent(stat.shipmentRowId)}/labels/custom`,
    body: variables => variables.body,
    invalidate: ['list'],
    silent: true,
  })
  const defaultName = templates.find(item => item.isDefault)?.name
  return (
    <FormAction
      label="生成自定义箱标签"
      guard={{ ...guard, condition: { ok: (stat.boxes ?? 0) > 0, reason: '这个货件还没有箱数（运输方案确认后才有），暂时不能生成箱标签' } }}
      title={`生成自定义箱标签：${stat.shipmentId}`}
      description="在亚马逊箱标签的基础上追加文字（亚马逊标签不改动）：箱号、原产地、SKU 等按模板勾选；箱内内容只有能确定时才印。由后台任务生成，完成后到导出中心下载。"
      okText="开始生成"
      successText="已交给后台任务生成，完成后到导出中心下载"
      width={560}
      buttonProps={{ size: 'small', type: 'primary' }}
      initialValues={{ templateId: DEFAULT_TEMPLATE }}
      onSubmit={async values => {
        const templateId = values.templateId === DEFAULT_TEMPLATE || !values.templateId ? undefined : String(values.templateId)
        const startNumber = typeof values.startNumber === 'number' ? values.startNumber : undefined
        const response = await post.mutateAsync({ body: { ...(templateId ? { templateId } : {}), ...(startNumber !== undefined ? { startNumber } : {}) } })
        onGenerated(response)
        return response
      }}
    >
      <TemplateHint stat={stat} templates={templates} />
      <Form.Item label="标签模板" name="templateId" extra={`不选就用默认模板（${defaultName ?? '系统内置的默认设置'}）；模板在“设置 → 标签模板”里维护`}>
        <Select
          aria-label="标签模板"
          options={[
            { value: DEFAULT_TEMPLATE, label: `默认（${defaultName ?? '系统内置的默认设置'}）` },
            ...templates.map(item => ({ value: item.id, label: `${item.name}（${LABEL_PAPER_SPEC[item.paper].label}）` })),
          ]}
        />
      </Form.Item>
      <Form.Item label="箱号起始序号（选填）" name="startNumber" extra="不填就接着这个计划前面的货件往下编；填了就从这个数开始">
        <InputNumber aria-label="箱号起始序号" min={0} max={BOX_NO_START_MAX} precision={0} style={{ width: 200 }} />
      </Form.Item>
    </FormAction>
  )
}

export function ItemLabelAction({
  planId,
  shipments,
  presetShipmentRowId,
  onGenerated,
  buttonSize,
}: {
  planId: string
  shipments: ReadonlyArray<{ id: string; shipmentId: string }>
  presetShipmentRowId?: string
  onGenerated: Generated
  buttonSize?: 'small'
}) {
  const guard = useGenerateGuard()
  const post = useApiMutation<{ body: Record<string, unknown> }, LabelGenerateResponse>({
    method: 'POST',
    path: () => `/inbound/plans/${encodeURIComponent(planId)}/item-labels`,
    body: variables => variables.body,
    invalidate: ['list'],
    silent: true,
  })
  return (
    <FormAction
      label="生成商品标签（PDF）"
      guard={guard}
      title="生成商品标签（FNSKU 条码）"
      description={
        <Alert
          type="info"
          showIcon
          message="按数量逐张生成 Code 128 条码标签（PDF），贴在每件商品上。不选货件就按整个计划的商品数量；缺 FNSKU 的商品默认拦下，勾选“跳过”才会略过并在说明里列出。"
          description={`一次最多 ${ITEM_LABEL_MAX} 张；由后台任务生成，完成后到导出中心下载。`}
        />
      }
      okText="开始生成"
      successText="已交给后台任务生成，完成后到导出中心下载"
      width={560}
      buttonProps={buttonSize === 'small' ? { size: 'small' } : { type: 'primary' }}
      initialValues={{ size: 'THERMAL_60X40', showTitle: false, showCondition: true, skipMissingFnsku: false, shipmentId: presetShipmentRowId }}
      onSubmit={async values => {
        const response = await post.mutateAsync({
          body: {
            size: values.size,
            showTitle: values.showTitle === true,
            showCondition: values.showCondition === true,
            skipMissingFnsku: values.skipMissingFnsku === true,
            ...(values.shipmentId ? { shipmentId: String(values.shipmentId) } : {}),
          },
        })
        onGenerated(response)
        return response
      }}
    >
      <Form.Item label="标签纸规格" name="size" rules={[{ required: true, message: '请选择标签纸规格' }]} extra="A4 不干胶两种是常见版式，实际边距以你买的标签纸为准，先小批量试印再大批量印">
        <Select aria-label="标签纸规格" options={ITEM_LABEL_SIZES.map(value => ({ value, label: ITEM_LABEL_SIZE_SPEC[value].label }))} />
      </Form.Item>
      {presetShipmentRowId ? null : (
        <Form.Item label="货件（不选则整个计划）" name="shipmentId">
          <Select allowClear aria-label="货件" options={shipments.map(item => ({ value: item.id, label: item.shipmentId }))} />
        </Form.Item>
      )}
      <Space direction="vertical" size={0}>
        <Form.Item name="showTitle" valuePropName="checked" style={{ marginBottom: 4 }}>
          <Checkbox>印品名（品名含中文时 worker 要配置中文字体，否则生成失败并写明原因）</Checkbox>
        </Form.Item>
        <Form.Item name="showCondition" valuePropName="checked" style={{ marginBottom: 4 }}>
          <Checkbox>印“New”（商品状况）</Checkbox>
        </Form.Item>
        <Form.Item name="skipMissingFnsku" valuePropName="checked" style={{ marginBottom: 4 }}>
          <Checkbox>跳过没有 FNSKU 的商品（否则有一个缺就整个拦下）</Checkbox>
        </Form.Item>
      </Space>
    </FormAction>
  )
}
