import { useState } from 'react'
import { Button, Drawer, Input, InputNumber, Select, Space, Typography } from 'antd'
import { BOX_COUNT_MAX, BOX_ITEMS_MAX, BOX_ITEM_QTY_MAX, BOX_SPEC_KEYS, BOX_SPEC_LABEL, BOX_SPEC_MAX, type BoxDraft } from '@nova/api-contracts'

// 编辑一个箱子：箱号、相同箱数、重量与尺寸、箱内商品（从计划里的 SKU 选，数量是每箱的数量）。
// 这里只改浏览器里的草稿；填写是否合格由保存草稿时统一校验。

type Props = { box: BoxDraft; planSkus: readonly string[]; onSave: (box: BoxDraft) => void; onClose: () => void }

const number = (value: number | null) => (value === null ? undefined : value)

export function BoxEditDrawer({ box, planSkus, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<BoxDraft>(box)
  const setItem = (index: number, patch: Partial<BoxDraft['items'][number]>) =>
    setDraft(current => ({ ...current, items: current.items.map((item, at) => (at === index ? { ...item, ...patch } : item)) }))
  const usedSkus = new Set(draft.items.map(item => item.sku))

  return (
    <Drawer
      open
      width={520}
      title={`编辑箱子 ${box.boxId}`}
      onClose={onClose}
      destroyOnClose
      footer={
        <Space>
          <Button type="primary" onClick={() => onSave({ ...draft, boxId: draft.boxId.trim() })}>
            应用修改
          </Button>
          <Button onClick={onClose}>取消</Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <label>
          <div>箱号</div>
          <Input aria-label="箱号" value={draft.boxId} maxLength={40} onChange={event => setDraft({ ...draft, boxId: event.target.value })} />
        </label>
        <label>
          <div>相同箱数（同样大小与内容的箱子有几个）</div>
          <InputNumber
            aria-label="相同箱数"
            min={1}
            max={BOX_COUNT_MAX}
            precision={0}
            value={number(draft.quantity)}
            onChange={value => setDraft({ ...draft, quantity: value })}
            style={{ width: 160 }}
          />
        </label>
        <Space wrap size={12}>
          {BOX_SPEC_KEYS.map(key => (
            <label key={key}>
              <div>{BOX_SPEC_LABEL[key]}</div>
              <InputNumber aria-label={BOX_SPEC_LABEL[key]} min={0} max={BOX_SPEC_MAX} value={number(draft[key])} onChange={value => setDraft({ ...draft, [key]: value })} style={{ width: 120 }} />
            </label>
          ))}
        </Space>
        <div>
          <Typography.Text strong>箱内商品（每箱的数量）</Typography.Text>
          <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
            {draft.items.map((item, index) => (
              <Space key={`${index}:${item.sku}`}>
                <Select
                  aria-label={`第 ${index + 1} 个商品的 SKU`}
                  showSearch
                  placeholder="选择 SKU"
                  value={item.sku || undefined}
                  style={{ width: 240 }}
                  options={planSkus.map(sku => ({ value: sku, label: sku, disabled: usedSkus.has(sku) && sku !== item.sku }))}
                  onChange={value => setItem(index, { sku: value })}
                />
                <InputNumber
                  aria-label={`第 ${index + 1} 个商品的每箱数量`}
                  min={1}
                  max={BOX_ITEM_QTY_MAX}
                  precision={0}
                  value={number(item.quantity)}
                  onChange={value => setItem(index, { quantity: value })}
                />
                <Button danger type="link" onClick={() => setDraft({ ...draft, items: draft.items.filter((_row, at) => at !== index) })}>
                  移除
                </Button>
              </Space>
            ))}
            <Button disabled={draft.items.length >= BOX_ITEMS_MAX || usedSkus.size >= planSkus.length} onClick={() => setDraft({ ...draft, items: [...draft.items, { sku: '', quantity: null }] })}>
              添加商品
            </Button>
          </Space>
        </div>
      </Space>
    </Drawer>
  )
}
