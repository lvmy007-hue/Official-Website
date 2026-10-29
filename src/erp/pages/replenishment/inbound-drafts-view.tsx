import { Card, InputNumber, Select, Space, Tag, Typography } from 'antd'
import type { InboundDraftGroup, ToInboundDraftsResult } from '@nova/api-contracts'
import { formatNumber } from '../../format'
import { AppLink } from '../../nav/AppLink'

// 转入仓计划草稿预览的内容（P6-08）：每组一张卡片（店铺 + 地址 = 一份草稿），卡片里逐个 SKU 改数量，卡片右上角改用该店铺的别的地址。
// 这里是少量 SKU 的确认表单，不是数据表格，所以不用表格组件；数字都是服务端预览算好的。

/** qty 为 null 表示用户把数量清空了（输入框保持空，等他重新填写；请求里按没改处理）。 */
export type Edit = { qty?: number | null; shipFromAddressId?: string }
export type Edits = Record<string, Edit>

const qtyValue = (edit: Edit | undefined, fallback: number) => (edit && 'qty' in edit ? edit.qty : fallback > 0 ? fallback : null)
const num = (value: number) => <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>

export function InboundDraftGroups({
  groups,
  edits,
  onChange,
  disabled,
}: {
  groups: readonly InboundDraftGroup[]
  edits: Edits
  onChange: (recommendationIds: readonly string[], patch: Edit) => void
  disabled: boolean
}) {
  if (groups.length === 0) return <Typography.Text type="secondary">没有可生成的内容</Typography.Text>
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {groups.map(group => {
        const ids = group.items.map(item => item.recommendationId)
        return (
          <Card
            key={group.key}
            size="small"
            title={
              <Space size={8} wrap>
                <strong>{group.planName}</strong>
                <Typography.Text type="secondary">
                  {group.skuCount} 个 SKU，共 {num(group.totalUnits)} 件
                </Typography.Text>
              </Space>
            }
            extra={
              <Space size={6}>
                <Typography.Text type="secondary">发货地址</Typography.Text>
                <Select
                  size="small"
                  aria-label={`${group.storeName} 的发货地址`}
                  style={{ width: 260 }}
                  disabled={disabled || group.addressOptions.length === 0}
                  value={group.address?.id}
                  placeholder={group.addressOptions.length === 0 ? '这个店铺还没有发货地址' : '请选择发货地址'}
                  options={group.addressOptions.map(option => ({ value: option.id, label: `${option.name}${option.isDefault ? '（默认）' : ''}` }))}
                  onChange={value => onChange(ids, { shipFromAddressId: value })}
                />
              </Space>
            }
          >
            {group.address ? (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
                {group.address.summary}
              </Typography.Paragraph>
            ) : null}
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {group.items.map(item => (
                <div key={item.recommendationId} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>{item.sku}</div>
                    <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, display: 'block' }}>
                      {item.title ?? item.asin}
                    </Typography.Text>
                  </div>
                  <Typography.Text type="secondary">建议量 {num(item.recommendedQty)}</Typography.Text>
                  <InputNumber
                    aria-label={`${item.sku} 数量`}
                    min={1}
                    max={10_000_000}
                    precision={0}
                    disabled={disabled}
                    style={{ width: 120 }}
                    value={qtyValue(edits[item.recommendationId], item.quantity)}
                    placeholder="填写数量"
                    onChange={value => onChange([item.recommendationId], { qty: typeof value === 'number' ? value : null })}
                  />
                  {item.edited ? (
                    <Tag bordered={false} color="orange" style={{ marginInlineEnd: 0 }}>
                      已改
                    </Tag>
                  ) : (
                    <span style={{ width: 42 }} />
                  )}
                </div>
              ))}
            </Space>
          </Card>
        )
      })}
    </Space>
  )
}

export function InboundDraftResult({ result }: { result: ToInboundDraftsResult }) {
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text>
        批次 {result.batchNo} 的 {result.actions} 条建议已转入 {result.plans.length} 份草稿；草稿只保存在我们这里，下一步到入仓计划里做资格预检。
      </Typography.Text>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {result.plans.map(plan => (
          <li key={plan.planId}>
            <AppLink to={`/app/supply-chain/${encodeURIComponent(plan.planId)}`}>
              <Typography.Link>{plan.name}</Typography.Link>
            </AppLink>
            （{plan.skuCount} 个 SKU，{num(plan.totalUnits)} 件，发货地址：{plan.shipFromAddressName}）
          </li>
        ))}
      </ul>
    </Space>
  )
}
