import { useState } from 'react'
import { Avatar, Button, Empty, List, Mentions, Space, Typography } from 'antd'
import { formatDateTime } from '../../format'

// 评论与关注（03 章 3.4 第 8 项）：对象级评论、@成员、关注。
// 数据与提交都由页面经接口完成；这里不保存任何本地假数据，提交失败原样提示。

export type CommentItem = { id: string; authorName: string; body: string; createdAt: string; mentions?: string[] }
export type MentionMember = { id: string; name: string }

/** 从评论正文里取出被 @ 的成员编号（按成员名匹配，去重）。 */
export function extractMentions(body: string, members: readonly MentionMember[]): string[] {
  const ids = new Set<string>()
  for (const member of members) if (body.includes(`@${member.name}`)) ids.add(member.id)
  return [...ids]
}

export function WatchButton({ watching, onToggle, disabledReason }: { watching: boolean; onToggle: () => Promise<void> | void; disabledReason?: string }) {
  const [busy, setBusy] = useState(false)
  const click = async () => {
    setBusy(true)
    try {
      await onToggle()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button loading={busy} disabled={!!disabledReason} title={disabledReason} onClick={click} aria-pressed={watching}>
      {watching ? '已关注' : '关注'}
    </Button>
  )
}

export function CommentThread(props: { items: CommentItem[]; members: MentionMember[]; onSubmit: (input: { body: string; mentions: string[] }) => Promise<void>; disabledReason?: string }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    const body = text.trim()
    if (!body) return
    setBusy(true)
    setError(null)
    try {
      await props.onSubmit({ body, mentions: extractMentions(body, props.members) })
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '评论提交失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-testid="comment-thread">
      {props.items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有评论，写下第一条协作记录" />
      ) : (
        <List
          size="small"
          dataSource={props.items}
          renderItem={item => (
            <List.Item key={item.id} style={{ alignItems: 'flex-start' }}>
              <List.Item.Meta
                avatar={<Avatar size="small">{item.authorName.slice(0, 1)}</Avatar>}
                title={
                  <Space size={8}>
                    <span>{item.authorName}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {formatDateTime(item.createdAt)}
                    </Typography.Text>
                  </Space>
                }
                description={<span style={{ whiteSpace: 'pre-wrap', color: 'var(--ant-color-text)' }}>{item.body}</span>}
              />
            </List.Item>
          )}
        />
      )}
      <Mentions
        aria-label="评论内容"
        rows={2}
        value={text}
        onChange={setText}
        disabled={!!props.disabledReason || busy}
        placeholder="输入评论，用 @ 提到同事"
        options={props.members.map(member => ({ value: member.name, label: member.name }))}
        style={{ marginTop: 8 }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, gap: 8 }}>
        <Typography.Text type={error ? 'danger' : 'secondary'} style={{ fontSize: 12 }} role={error ? 'alert' : undefined}>
          {error ?? props.disabledReason ?? ''}
        </Typography.Text>
        <Button type="primary" size="small" loading={busy} disabled={!text.trim() || !!props.disabledReason} onClick={submit}>
          发表
        </Button>
      </div>
    </div>
  )
}
