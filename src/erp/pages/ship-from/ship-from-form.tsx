import { Checkbox, Form, Input, Select } from 'antd'
import { SHIP_FROM_LIMIT_PER_STORE, type ShipFromRow } from '@nova/api-contracts'

// 发货地址的表单项（新增与修改共用）：字段按入仓接口的要求——名称、地址行、城市、州或省代码、邮编、国家代码、电话。
// 修改时店铺不能换（换店铺请新建），也没有“设为默认”勾选（设默认用行上的“设为默认”）。

export type ShipFromValues = {
  sellerAccountId?: string
  name?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  stateOrProvince?: string
  postalCode?: string
  countryCode?: string
  phone?: string
  isDefault?: boolean
}

const trim = (value: string | undefined) => (value ?? '').trim()

/** 表单值 → 接口请求体（字符串去首尾空格；地址行 2 为空时新增不传、修改传空表示清空）。 */
export function shipFromBody(values: ShipFromValues, mode: 'create' | 'update') {
  const line2 = trim(values.addressLine2)
  return {
    ...(mode === 'create' ? { sellerAccountId: values.sellerAccountId, isDefault: values.isDefault === true } : {}),
    name: trim(values.name),
    addressLine1: trim(values.addressLine1),
    ...(mode === 'create' ? (line2 ? { addressLine2: line2 } : {}) : { addressLine2: line2 }),
    city: trim(values.city),
    stateOrProvince: trim(values.stateOrProvince),
    postalCode: trim(values.postalCode),
    countryCode: trim(values.countryCode),
    phone: trim(values.phone),
  }
}

export const shipFromInitialValues = (row: ShipFromRow): ShipFromValues => ({
  name: row.name,
  addressLine1: row.addressLine1,
  addressLine2: row.addressLine2 ?? '',
  city: row.city,
  stateOrProvince: row.stateOrProvince,
  postalCode: row.postalCode,
  countryCode: row.countryCode,
  phone: row.phone,
})

const required = (message: string) => [{ required: true, whitespace: true, message }]

export function ShipFromFormItems({ stores, editing }: { stores: ReadonlyArray<{ id: string; name: string }>; editing: boolean }) {
  return (
    <>
      {editing ? null : (
        <Form.Item label="店铺" name="sellerAccountId" rules={[{ required: true, message: '请选择店铺' }]} extra={`每个店铺最多保存 ${SHIP_FROM_LIMIT_PER_STORE} 个地址；店铺的第一个地址自动成为默认`}>
          <Select aria-label="店铺" showSearch optionFilterProp="label" placeholder="选择店铺" options={stores.map(store => ({ value: store.id, label: store.name }))} style={{ width: 320 }} />
        </Form.Item>
      )}
      <Form.Item label="地址名称" name="name" rules={required('请填写地址名称')} extra="给自己看的名字，同一店铺内不能重复，例如“深圳仓”">
        <Input aria-label="地址名称" maxLength={50} style={{ width: 320 }} />
      </Form.Item>
      <Form.Item label="地址行 1" name="addressLine1" rules={required('请填写地址行 1')}>
        <Input aria-label="地址行 1" maxLength={180} />
      </Form.Item>
      <Form.Item label="地址行 2（选填）" name="addressLine2">
        <Input aria-label="地址行 2" maxLength={60} />
      </Form.Item>
      <Form.Item label="城市" name="city" rules={required('请填写城市')}>
        <Input aria-label="城市" maxLength={50} style={{ width: 240 }} />
      </Form.Item>
      <Form.Item label="州或省代码" name="stateOrProvince" rules={required('请填写州或省代码')} extra="入仓接口要的是代码，例如 CA、GD，不是全称">
        <Input aria-label="州或省代码" maxLength={10} style={{ width: 160 }} />
      </Form.Item>
      <Form.Item label="邮编" name="postalCode" rules={required('请填写邮编')}>
        <Input aria-label="邮编" maxLength={20} style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="国家代码" name="countryCode" rules={[{ required: true, pattern: /^[A-Za-z]{2}$/, message: '两位字母，例如 CN、US' }]}>
        <Input aria-label="国家代码" maxLength={2} style={{ width: 100 }} />
      </Form.Item>
      <Form.Item label="电话" name="phone" rules={required('请填写电话')}>
        <Input aria-label="电话" maxLength={30} style={{ width: 240 }} />
      </Form.Item>
      {editing ? null : (
        <Form.Item name="isDefault" valuePropName="checked">
          <Checkbox>设为这个店铺的默认地址</Checkbox>
        </Form.Item>
      )}
    </>
  )
}
