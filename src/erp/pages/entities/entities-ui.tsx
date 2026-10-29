import { Form, Input, Tag } from 'antd'
import { LEGAL_ENTITY_STATUS_LABEL, entityStatusLabel } from '@nova/api-contracts'
import { formatNumber } from '../../format'

// 法律主体页面共用的小件：状态标签、编辑表单字段、提交内容的整理。

export function EntityStatusTag({ status }: { status: string }) {
  return (
    <Tag bordered={false} color={status === 'ACTIVE' ? 'success' : 'default'}>
      {entityStatusLabel(status)}
    </Tag>
  )
}

export const statusOptions = Object.entries(LEGAL_ENTITY_STATUS_LABEL).map(([value, label]) => ({ value, label }))

/** 店铺数、广告账户数这类真实的计数：0 就写 0（不是缺数据）。 */
export const countText = (value: number) => <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** 新增与编辑共用的字段。 */
export function EntityFields() {
  return (
    <>
      <Form.Item
        label="主体名称"
        name="name"
        rules={[
          { required: true, whitespace: true, message: '请填写主体名称' },
          { min: 2, message: '至少 2 个字' },
        ]}
      >
        <Input aria-label="主体名称" maxLength={200} />
      </Form.Item>
      <Form.Item
        label="注册地"
        name="registeredCountry"
        rules={[
          { required: true, whitespace: true, message: '请填写注册地' },
          { min: 2, message: '至少 2 个字' },
        ]}
      >
        <Input aria-label="注册地" maxLength={80} placeholder="例如：中国、美国特拉华州" />
      </Form.Item>
      <Form.Item label="注册号" name="registrationNo" extra="统一社会信用代码或境外注册号；没有可以留空。">
        <Input aria-label="注册号" maxLength={120} />
      </Form.Item>
    </>
  )
}

/** 新增：空的注册号不带上。 */
export const createBody = (values: Record<string, unknown>): Record<string, unknown> => ({
  name: trimmed(values.name),
  registeredCountry: trimmed(values.registeredCountry),
  ...(trimmed(values.registrationNo) ? { registrationNo: trimmed(values.registrationNo) } : {}),
})

/** 修改：注册号清空时传 null（服务端把它当作清空）。 */
export const updateBody = (values: Record<string, unknown>, version: number): Record<string, unknown> => ({
  version,
  name: trimmed(values.name),
  registeredCountry: trimmed(values.registeredCountry),
  registrationNo: trimmed(values.registrationNo) || null,
})
