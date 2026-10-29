import { useState } from 'react'
import { Button, Empty, Input, List, Space, Tag, Typography } from 'antd'
import { formatDateTime } from '../../format'

// 运营日志（03 章 3.4 第 11 项）：自动记录系统内与亚马逊侧可识别的变更，支持手工补充工作记录；
// 与事件标注、前后对照联动。手工记录由页面经接口保存，失败原样提示。

export type OperationEntry = {
  id: string
  at: string
  source: 'system' | 'amazon' | 'manual'
  title: string
  detail?: string
  actor?: string
}

const SOURCE_LABEL = { system: '系统内操作', amazon: '亚马逊侧变更', manual: '手工记录' } as const
const SOURCE_COLOR = { system: 'processing', amazon: 'warning', manual: 'default' } as const

export function OperationLog(props: { entries: OperationEntry[]; onAddNote?: (text: string) => Promise<void>; onCompare?: (entry: OperationEntry) => void; noteDisabledReason?: string }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async () => {
    if (!props.onAddNote || !text.trim()) return
    setBusy(true)
    setError(null)
    try {
      await props.onAddNote(text.trim())
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '记录保存失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-testid="operation-log">
      {props.onAddNote ? (
        <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
          <Input
            aria-label="工作记录"
            placeholder="补充一条工作记录，例如调整了主图"
            value={text}
            maxLength={500}
            disabled={!!props.noteDisabledReason || busy}
            onChange={event => setText(event.target.value)}
            onPressEnter={() => void add()}
          />
          <Button type="primary" loading={busy} disabled={!text.trim() || !!props.noteDisabledReason} onClick={() => void add()} title={props.noteDisabledReason}>
            记录
          </Button>
        </Space.Compact>
      ) : null}
      {error ? (
        <Typography.Text type="danger" role="alert">
          {error}
        </Typography.Text>
      ) : null}
      {props.entries.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运营记录" />
      ) : (
        <List
          size="small"
          dataSource={props.entries}
          renderItem={entry => (
            <List.Item
              key={entry.id}
              actions={
                props.onCompare
                  ? [
                      <Typography.Link key="c" onClick={() => props.onCompare?.(entry)}>
                        前后对照
                      </Typography.Link>,
                    ]
                  : undefined
              }
            >
              <List.Item.Meta
                title={
                  <Space size={6}>
                    <span>{entry.title}</span>
                    <Tag bordered={false} color={SOURCE_COLOR[entry.source]}>
                      {SOURCE_LABEL[entry.source]}
                    </Tag>
                  </Space>
                }
                description={
                  <span>
                    {formatDateTime(entry.at)}
                    {entry.actor ? ` · ${entry.actor}` : ''}
                    {entry.detail ? ` · ${entry.detail}` : ''}
                  </span>
                }
              />
            </List.Item>
          )}
        />
      )}
    </div>
  )
}
