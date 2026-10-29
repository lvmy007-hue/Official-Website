import { DatePicker, Form, Input, InputNumber, Select, Typography } from 'antd'
import dayjs from 'dayjs'
import {
  FORECAST_FACTOR_MAX,
  FORECAST_FIXED_MAX,
  FORECAST_MODES,
  FORECAST_MODE_LABEL,
  FORECAST_SCOPE_LABEL,
  FORECAST_SCOPE_TYPES,
  type ForecastMode,
  type ForecastOverrideRow,
  type ForecastScopeType,
} from '@nova/api-contracts'

// 人工预测规则的表单项（新增与修改共用）：对象（SKU 或品类）、起止日期（含首尾）、方式与数值、备注。
// 修改时对象不能换（换对象请新建一条）；日期用两个选择器，提交时转成 YYYY-MM-DD。

export type ForecastValues = {
  scopeType?: ForecastScopeType
  scopeId?: string
  from?: dayjs.Dayjs | null
  to?: dayjs.Dayjs | null
  mode?: ForecastMode
  value?: number | null
  note?: string
}

const day = (value: dayjs.Dayjs | null | undefined) => (value ? value.format('YYYY-MM-DD') : '')

/** 表单值 → 接口请求体；新增带对象，修改只带可改的字段与看到的版本号。 */
export function forecastBody(values: ForecastValues, mode: 'create' | 'update', version?: number) {
  const note = (values.note ?? '').trim()
  const rule = { from: day(values.from), to: day(values.to), mode: values.mode, value: values.value }
  if (mode === 'create') return { scopeType: values.scopeType, scopeId: (values.scopeId ?? '').trim(), ...rule, note: note || null }
  return { version, ...rule, note: note || null }
}

export const forecastInitialValues = (row: ForecastOverrideRow): ForecastValues => ({
  from: dayjs(row.from),
  to: dayjs(row.to),
  mode: row.mode,
  value: row.value,
  note: row.note ?? '',
})

export function ForecastFormItems({ editing }: { editing: boolean }) {
  return (
    <>
      {editing ? null : (
        <>
          <Form.Item label="对象类型" name="scopeType" rules={[{ required: true, message: '请选择对象类型' }]}>
            <Select aria-label="对象类型" style={{ width: 200 }} options={FORECAST_SCOPE_TYPES.map(value => ({ value, label: FORECAST_SCOPE_LABEL[value] }))} />
          </Form.Item>
          <Form.Item
            label="SKU 或商品类型"
            name="scopeId"
            rules={[{ required: true, whitespace: true, message: '请填写 SKU 或商品类型' }]}
            extra="SKU 规则对所有店铺里这个卖家 SKU 生效；品类规则对该商品类型的所有 SKU 生效。名称必须是已有商品。"
          >
            <Input aria-label="SKU 或商品类型" maxLength={120} style={{ width: 320 }} />
          </Form.Item>
        </>
      )}
      <Form.Item label="开始日期" name="from" rules={[{ required: true, message: '请选择开始日期' }]}>
        <DatePicker aria-label="开始日期" />
      </Form.Item>
      <Form.Item label="结束日期" name="to" rules={[{ required: true, message: '请选择结束日期' }]} extra="含首尾，时间段最长 366 天；结束日期不能早于今天">
        <DatePicker aria-label="结束日期" />
      </Form.Item>
      <Form.Item label="方式" name="mode" rules={[{ required: true, message: '请选择方式' }]}>
        <Select aria-label="方式" style={{ width: 240 }} options={FORECAST_MODES.map(value => ({ value, label: FORECAST_MODE_LABEL[value] }))} />
      </Form.Item>
      <Form.Item noStyle dependencies={['mode']}>
        {({ getFieldValue }) => {
          const factor = getFieldValue('mode') === 'YOY_FACTOR'
          return (
            <Form.Item
              label={factor ? '同期系数' : '固定日销（件/天）'}
              name="value"
              rules={[{ required: true, message: factor ? '请填写同期系数' : '请填写日销' }]}
              extra={factor ? `去年同一段日期的日均销量乘这个系数；大于 0，最大 ${FORECAST_FACTOR_MAX}。去年同期没有销量记录时规则不生效。` : `0 表示这段时间不卖；最大 ${FORECAST_FIXED_MAX}`}
            >
              <InputNumber
                aria-label={factor ? '同期系数' : '固定日销'}
                min={factor ? 0.01 : 0}
                max={factor ? FORECAST_FACTOR_MAX : FORECAST_FIXED_MAX}
                precision={factor ? 2 : 1}
                style={{ width: 200 }}
              />
            </Form.Item>
          )
        }}
      </Form.Item>
      <Form.Item label="备注（选填）" name="note">
        <Input aria-label="备注" maxLength={200} />
      </Form.Item>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        规则只影响之后重新计算的批次，已生成的批次保持当时的结果。
      </Typography.Text>
    </>
  )
}
