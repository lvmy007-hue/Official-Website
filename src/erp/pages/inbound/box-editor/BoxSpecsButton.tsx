import { useState } from 'react'
import { Alert, Button, InputNumber, Modal, Space } from 'antd'
import { BOX_SPEC_KEYS, BOX_SPEC_LABEL, BOX_SPEC_MAX, type BoxSpecKey, type BoxSpecs } from '@nova/api-contracts'

// 批量设箱规：对选中的箱子一次填重量与尺寸；没填的项保持原值。

type Props = { count: number; onApply: (specs: BoxSpecs) => void }

export function BoxSpecsButton({ count, onApply }: Props) {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Partial<Record<BoxSpecKey, number | null>>>({})
  const specs: BoxSpecs = {}
  for (const key of BOX_SPEC_KEYS) {
    const value = values[key]
    if (typeof value === 'number' && value > 0) specs[key] = value
  }
  const filled = Object.keys(specs).length
  const close = () => {
    setOpen(false)
    setValues({})
  }
  return (
    <>
      <Button size="small" disabled={count === 0} onClick={() => setOpen(true)}>
        批量设箱规
      </Button>
      <Modal
        open={open}
        title={`批量设箱规（${count} 个箱子）`}
        okText="应用"
        cancelText="取消"
        okButtonProps={{ disabled: filled === 0 }}
        onCancel={close}
        onOk={() => {
          onApply(specs)
          close()
        }}
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert type="info" showIcon message="只改你填了的项；没填的项保持每个箱子原来的值。修改只在页面里，点“保存草稿”后才会保存。" />
          <Space wrap size={12}>
            {BOX_SPEC_KEYS.map(key => (
              <label key={key}>
                <div>{BOX_SPEC_LABEL[key]}</div>
                <InputNumber
                  aria-label={`批量${BOX_SPEC_LABEL[key]}`}
                  min={0}
                  max={BOX_SPEC_MAX}
                  value={values[key] ?? undefined}
                  onChange={value => setValues(current => ({ ...current, [key]: value }))}
                  style={{ width: 120 }}
                />
              </label>
            ))}
          </Space>
        </Space>
      </Modal>
    </>
  )
}
