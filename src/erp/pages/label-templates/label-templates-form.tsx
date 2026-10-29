import { Alert, Checkbox, Form, Input, InputNumber, Select, Space, Typography } from 'antd'
import {
  BOX_NO_DIGITS_MAX,
  BOX_NO_JOINER_MAX,
  BOX_NO_PART_MAX,
  BOX_NO_START_MAX,
  DEFAULT_BOX_NO_RULE,
  DEFAULT_LABEL_OPTIONS,
  LABEL_FONT_NOTE,
  LABEL_NAME_MAX,
  LABEL_ORDERS,
  LABEL_ORDER_LABEL,
  LABEL_ORIGIN_MAX,
  LABEL_OPTION_META,
  LABEL_PAPERS,
  LABEL_PAPER_SPEC,
  LABEL_SIGN_WARNING,
  boxNoPreview,
  validateLabelTemplate,
  type BoxNoRule,
  type LabelOptions,
  type LabelPaper,
  type LabelTemplateRow,
} from '@nova/api-contracts'

// 标签模板的表单项（新增与修改共用）：名称、纸张、勾选项（每项写明什么条件下才会真正印出来）、标签顺序、箱号规则（实时预览）、设为默认。
// 校验与接口共用契约里的 validateLabelTemplate，纸张与选项的组合、箱号规则的问题在提交前就能看到。

export type LabelTemplateValues = {
  name?: string
  paper?: LabelPaper
  options?: Partial<LabelOptions>
  boxNoRule?: Partial<BoxNoRule>
  isDefault?: boolean
}

export const labelTemplateDefaults = (): LabelTemplateValues => ({ name: '', paper: 'THERMAL_4X6', options: { ...DEFAULT_LABEL_OPTIONS }, boxNoRule: { ...DEFAULT_BOX_NO_RULE }, isDefault: false })
export const labelTemplateInitialValues = (row: LabelTemplateRow): LabelTemplateValues => ({
  name: row.name,
  paper: row.paper,
  options: { ...row.options },
  boxNoRule: { ...row.boxNoRule },
  isDefault: row.isDefault,
})

const complete = (values: LabelTemplateValues) => ({
  name: (values.name ?? '').trim(),
  paper: values.paper ?? 'THERMAL_4X6',
  options: { ...DEFAULT_LABEL_OPTIONS, ...values.options },
  boxNoRule: { ...DEFAULT_BOX_NO_RULE, ...values.boxNoRule },
})

/** 表单值 → 接口请求体（名称去首尾空格；缺的字段用默认值补齐）。 */
export const labelTemplateBody = (values: LabelTemplateValues) => ({ ...complete(values), isDefault: values.isDefault === true })

/** 某个字段上的校验：同一份契约校验，找出挂在这个字段上的第一条问题。 */
const issueRule =
  (field: string) =>
  ({ getFieldsValue }: { getFieldsValue: (all: true) => LabelTemplateValues }) => ({
    validator: async () => {
      const issue = validateLabelTemplate(complete(getFieldsValue(true))).find(item => item.field === field)
      if (issue) throw new Error(issue.message)
    },
  })
const DEPENDS = ['paper', 'options', 'boxNoRule']

function BoxNoPreview() {
  const form = Form.useFormInstance<LabelTemplateValues>()
  const rule = { ...DEFAULT_BOX_NO_RULE, ...(Form.useWatch('boxNoRule', form) ?? {}) }
  const overall = validateLabelTemplate(complete({ ...form.getFieldsValue(true), boxNoRule: rule })).find(item => item.field === 'boxNoRule')
  return (
    <Typography.Paragraph type={overall ? 'danger' : 'secondary'} style={{ marginBottom: 12 }} data-testid="box-no-preview">
      {overall ? overall.message : `预览（计划号以 PLAN 代替）：${boxNoPreview(rule, 'PLAN', 3).join('、')}……`}
    </Typography.Paragraph>
  )
}

function OptionChecks() {
  const form = Form.useFormInstance<LabelTemplateValues>()
  const paper = Form.useWatch('paper', form) ?? 'THERMAL_4X6'
  return (
    <>
      {LABEL_OPTION_META.map(item => {
        const blocked = item.key === 'appendToOriginal' && !LABEL_PAPER_SPEC[paper].overlayAllowed
        return (
          <Form.Item
            key={item.key}
            name={['options', item.key]}
            valuePropName="checked"
            style={{ marginBottom: 8 }}
            dependencies={DEPENDS}
            rules={[issueRule(`options.${item.key}`)]}
            extra={item.condition}
          >
            <Checkbox disabled={blocked}>{item.label}</Checkbox>
          </Form.Item>
        )
      })}
    </>
  )
}

export function LabelTemplateFormItems({ editing }: { editing: boolean }) {
  const form = Form.useFormInstance<LabelTemplateValues>()
  // 换成多张拼版的纸张时，“追加到原标签”不适用：自动取消勾选（该选项同时置灰），避免用户卡在一个取消不掉的勾选上
  const changePaper = (paper: LabelPaper) => {
    if (!LABEL_PAPER_SPEC[paper].overlayAllowed) form.setFieldValue(['options', 'appendToOriginal'], false)
  }
  return (
    <>
      <Form.Item label="模板名称" name="name" rules={[{ required: true, whitespace: true, message: '请填写模板名称' }, issueRule('name')]} extra="给自己看的名字，同一企业内不能重复，例如“热敏纸标准”">
        <Input aria-label="模板名称" maxLength={LABEL_NAME_MAX} style={{ width: 320 }} />
      </Form.Item>
      <Form.Item label="纸张规格" name="paper" rules={[{ required: true, message: '请选择纸张规格' }]} extra="决定向亚马逊取哪种页面类型的箱标签作为底；取不到对应纸张的文件时，生成前会提示先去取">
        <Select aria-label="纸张规格" style={{ width: 320 }} onChange={changePaper} options={LABEL_PAPERS.map(value => ({ value, label: LABEL_PAPER_SPEC[value].label }))} />
      </Form.Item>
      <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={LABEL_SIGN_WARNING} />
      <Form.Item label="标签上追加的内容" style={{ marginBottom: 4 }}>
        <OptionChecks />
      </Form.Item>
      <Form.Item label="原产地文字" name={['options', 'originText']} dependencies={DEPENDS} rules={[issueRule('options.originText')]}>
        <Input aria-label="原产地文字" maxLength={LABEL_ORIGIN_MAX} style={{ width: 320 }} />
      </Form.Item>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message={LABEL_FONT_NOTE} />
      <Form.Item
        label="标签顺序"
        name={['options', 'order']}
        dependencies={DEPENDS}
        rules={[issueRule('options.order')]}
        extra="“我方箱号顺序”只有热敏纸（一页一张）可选；目前我方箱号与亚马逊箱序号一一对应，两种顺序的结果相同。"
      >
        <Select aria-label="标签顺序" style={{ width: 320 }} options={LABEL_ORDERS.map(value => ({ value, label: LABEL_ORDER_LABEL[value] }))} />
      </Form.Item>
      <Form.Item label="箱号规则" style={{ marginBottom: 4 }} extra="箱号只能用字母、数字和 _ . # / -；每个货件的编号接着上一个货件往下排">
        <Space wrap size={12} align="start">
          <Form.Item name={['boxNoRule', 'prefix']} label="前缀" dependencies={DEPENDS} rules={[issueRule('boxNoRule.prefix')]} style={{ marginBottom: 8 }}>
            <Input aria-label="箱号前缀" maxLength={BOX_NO_PART_MAX} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name={['boxNoRule', 'includePlanNo']} valuePropName="checked" label="带计划号" style={{ marginBottom: 8 }}>
            <Checkbox aria-label="箱号带计划号" />
          </Form.Item>
          <Form.Item name={['boxNoRule', 'digits']} label="数字位数" dependencies={DEPENDS} rules={[issueRule('boxNoRule.digits')]} style={{ marginBottom: 8 }}>
            <InputNumber aria-label="数字位数" min={1} max={BOX_NO_DIGITS_MAX} precision={0} style={{ width: 90 }} />
          </Form.Item>
          <Form.Item name={['boxNoRule', 'start']} label="起始序号" dependencies={DEPENDS} rules={[issueRule('boxNoRule.start')]} style={{ marginBottom: 8 }}>
            <InputNumber aria-label="起始序号" min={0} max={BOX_NO_START_MAX} precision={0} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name={['boxNoRule', 'suffix']} label="后缀" dependencies={DEPENDS} rules={[issueRule('boxNoRule.suffix')]} style={{ marginBottom: 8 }}>
            <Input aria-label="箱号后缀" maxLength={BOX_NO_PART_MAX} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name={['boxNoRule', 'joiner']} label="连接符" dependencies={DEPENDS} rules={[issueRule('boxNoRule.joiner')]} style={{ marginBottom: 8 }}>
            <Input aria-label="箱号连接符" maxLength={BOX_NO_JOINER_MAX} style={{ width: 90 }} />
          </Form.Item>
        </Space>
      </Form.Item>
      <BoxNoPreview />
      <Form.Item name="isDefault" valuePropName="checked" extra={editing ? undefined : '生成自定义箱标签时不选模板就用默认模板；全企业只有一个默认，设置后原来的默认自动取消'}>
        <Checkbox>设为默认模板</Checkbox>
      </Form.Item>
    </>
  )
}
