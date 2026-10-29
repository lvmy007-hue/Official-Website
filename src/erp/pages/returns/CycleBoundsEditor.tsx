import { useState } from 'react'
import { Button, Input, Space, Typography } from 'antd'
import { RETURN_CYCLE_DEFAULT_BOUNDS, RETURN_CYCLE_MAX_BOUNDS, parseBounds } from '@nova/api-contracts'

// 天数段设置（M-700）：填各段的上界，例如 7,14,30,60,90 表示 0–7、8–14、15–30、31–60、61–90、90 天以上。
// 同一时刻只用一套；写在地址栏里并记在本机，下次打开沿用。填错（不是递增的整数等）直接说明原因，不悄悄改成默认值。

const DEFAULT_TEXT = RETURN_CYCLE_DEFAULT_BOUNDS.join(',')

export function CycleBoundsEditor({ current, onApply }: { current: string | undefined; onApply: (value: string | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const text = draft ?? current ?? DEFAULT_TEXT

  const apply = () => {
    const parsed = parseBounds(text)
    if (parsed.error) {
      setProblem(parsed.error)
      return
    }
    setProblem(null)
    setDraft(null)
    // 与默认一套相同时不写地址栏，保持链接干净
    onApply(parsed.bounds.join(',') === DEFAULT_TEXT ? null : parsed.bounds.join(','))
  }

  return (
    <Space direction="vertical" size={4}>
      <Space size={8} wrap>
        <Typography.Text>天数段分界点</Typography.Text>
        <Input
          aria-label="天数段分界点"
          style={{ width: 220 }}
          value={text}
          status={problem ? 'error' : undefined}
          onChange={event => {
            setDraft(event.target.value)
            setProblem(null)
          }}
          onPressEnter={apply}
          placeholder={DEFAULT_TEXT}
        />
        <Button onClick={apply}>应用</Button>
        <Button
          onClick={() => {
            setDraft(null)
            setProblem(null)
            onApply(null)
          }}
        >
          恢复默认
        </Button>
      </Space>
      <Typography.Text type={problem ? 'danger' : 'secondary'} role={problem ? 'alert' : undefined}>
        {problem ?? `用英文逗号隔开，从小到大，最多 ${RETURN_CYCLE_MAX_BOUNDS} 个；默认 ${DEFAULT_TEXT}。`}
      </Typography.Text>
    </Space>
  )
}
