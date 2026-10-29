import { Button, Card, Form, Input, InputNumber, Select, Space, Typography } from 'antd'
import { AWD_PACKAGE_TYPE_LABEL } from '@nova/api-contracts'

// 入库订单的包装表单（亚马逊仓储分销要求按“箱”或“托盘”提交）：
// - 箱：装若干种商品；托盘：装若干箱（只能一层，箱里装商品）；
// - 提交亚马逊前每个包装都要有重量与长宽高；预处理方与贴标方固定为卖家，不提供选项。
// 表单项的名字都是相对于最近的 Form.List 的，所以同一组字段既能用在顶层包装，也能用在托盘里的箱。

const positive = (label: string) => [{ required: true, message: `请填写${label}` }]
const required = (label: string) => [{ required: true, whitespace: true, message: `请填写${label}` }]

function Products({ index }: { index: number }) {
  return (
    <Form.List name={[index, 'products']}>
      {(fields, { add, remove }) => (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          {fields.map(field => (
            <Space key={field.key} align="start" wrap>
              <Form.Item name={[field.name, 'sku']} rules={required('SKU')} style={{ marginBottom: 0 }}>
                <Input placeholder="SKU" aria-label="商品 SKU" style={{ width: 180 }} />
              </Form.Item>
              <Form.Item name={[field.name, 'quantity']} rules={positive('每包装件数')} style={{ marginBottom: 0 }}>
                <InputNumber min={1} max={1_000_000} precision={0} placeholder="每包装件数" aria-label="每包装件数" style={{ width: 120 }} />
              </Form.Item>
              <Form.Item name={[field.name, 'expiration']} rules={[{ pattern: /^\d{4}-\d{2}-\d{2}$/, message: '格式 YYYY-MM-DD' }]} style={{ marginBottom: 0 }}>
                <Input placeholder="到期日 YYYY-MM-DD（选填）" aria-label="到期日" style={{ width: 200 }} />
              </Form.Item>
              <Button type="link" danger onClick={() => remove(field.name)}>
                删除商品
              </Button>
            </Space>
          ))}
          <Button size="small" onClick={() => add({ quantity: 1 })}>
            添加商品
          </Button>
        </Space>
      )}
    </Form.List>
  )
}

function Measurements({ index }: { index: number }) {
  return (
    <Space wrap align="start">
      <Form.Item label="重量" required style={{ marginBottom: 0 }}>
        <Space.Compact>
          <Form.Item name={[index, 'measurements', 'weight', 'value']} rules={positive('重量')} noStyle>
            <InputNumber min={0.01} max={1_000_000} placeholder="重量" aria-label="重量" style={{ width: 100 }} />
          </Form.Item>
          <Form.Item name={[index, 'measurements', 'weight', 'unit']} noStyle initialValue="KILOGRAMS">
            <Select
              aria-label="重量单位"
              style={{ width: 90 }}
              options={[
                { value: 'KILOGRAMS', label: '千克' },
                { value: 'POUNDS', label: '磅' },
              ]}
            />
          </Form.Item>
        </Space.Compact>
      </Form.Item>
      <Form.Item label="长 × 宽 × 高" style={{ marginBottom: 0 }} extra="提交亚马逊前必填">
        <Space.Compact>
          {(['length', 'width', 'height'] as const).map(side => (
            <Form.Item key={side} name={[index, 'measurements', 'dimensions', side]} noStyle>
              <InputNumber
                min={0.01}
                max={1_000_000}
                placeholder={{ length: '长', width: '宽', height: '高' }[side]}
                aria-label={{ length: '长', width: '宽', height: '高' }[side]}
                style={{ width: 80 }}
              />
            </Form.Item>
          ))}
          <Form.Item name={[index, 'measurements', 'dimensions', 'unit']} noStyle initialValue="CENTIMETERS">
            <Select
              aria-label="尺寸单位"
              style={{ width: 90 }}
              options={[
                { value: 'CENTIMETERS', label: '厘米' },
                { value: 'INCHES', label: '英寸' },
              ]}
            />
          </Form.Item>
        </Space.Compact>
      </Form.Item>
    </Space>
  )
}

function CaseBody({ index }: { index: number }) {
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Form.Item name={[index, 'count']} label="包装数量" rules={positive('包装数量')} style={{ marginBottom: 0 }}>
        <InputNumber min={1} max={100_000} precision={0} aria-label="包装数量" style={{ width: 120 }} />
      </Form.Item>
      <Measurements index={index} />
      <Typography.Text type="secondary">每个包装里装的商品</Typography.Text>
      <Products index={index} />
    </Space>
  )
}

function PalletBody({ index }: { index: number }) {
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Form.Item name={[index, 'count']} label="托盘数量" rules={positive('托盘数量')} style={{ marginBottom: 0 }}>
        <InputNumber min={1} max={100_000} precision={0} aria-label="托盘数量" style={{ width: 120 }} />
      </Form.Item>
      <Measurements index={index} />
      <Typography.Text type="secondary">每个托盘里装的箱</Typography.Text>
      <Form.List name={[index, 'packages']}>
        {(fields, { add, remove }) => (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {fields.map(field => (
              <Card
                key={field.key}
                size="small"
                title={`箱 ${field.name + 1}`}
                extra={
                  <Button type="link" danger onClick={() => remove(field.name)}>
                    删除这个箱
                  </Button>
                }
              >
                <Form.Item name={[field.name, 'type']} hidden initialValue="CASE">
                  <Input />
                </Form.Item>
                <CaseBody index={field.name} />
              </Card>
            ))}
            <Button size="small" onClick={() => add({ type: 'CASE', count: 1, products: [{ quantity: 1 }] })}>
              添加箱
            </Button>
          </Space>
        )}
      </Form.List>
    </Space>
  )
}

/** 顶层包装列表。 */
export function PackagesField() {
  const form = Form.useFormInstance()
  const packages = Form.useWatch('packages', form) as Array<{ type?: 'CASE' | 'PALLET' } | undefined> | undefined
  return (
    <Form.List name="packages">
      {(fields, { add, remove }) => (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {fields.map(field => {
            const type = packages?.[field.name]?.type
            return (
              <Card
                key={field.key}
                size="small"
                title={`包装 ${field.name + 1}：${AWD_PACKAGE_TYPE_LABEL[type ?? 'CASE']}`}
                extra={
                  <Button type="link" danger onClick={() => remove(field.name)}>
                    删除包装
                  </Button>
                }
              >
                <Form.Item name={[field.name, 'type']} label="包装方式" style={{ marginBottom: 8 }}>
                  <Select
                    aria-label="包装方式"
                    style={{ width: 140 }}
                    options={Object.entries(AWD_PACKAGE_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
                    onChange={value => {
                      // 换包装方式时清掉不适用的内容（箱装商品、托盘装箱二选一），保留数量与尺寸重量
                      const current = form.getFieldValue(['packages', field.name]) as { count?: number; measurements?: unknown } | undefined
                      const contents = value === 'PALLET' ? { packages: [{ type: 'CASE', count: 1, products: [{ quantity: 1 }] }] } : { products: [{ quantity: 1 }] }
                      form.setFieldValue(['packages', field.name], { type: value, count: current?.count ?? 1, measurements: current?.measurements, ...contents })
                    }}
                  />
                </Form.Item>
                {type === 'PALLET' ? <PalletBody index={field.name} /> : <CaseBody index={field.name} />}
              </Card>
            )
          })}
          <Button onClick={() => add({ type: 'CASE', count: 1, products: [{ quantity: 1 }] })}>添加包装</Button>
        </Space>
      )}
    </Form.List>
  )
}
