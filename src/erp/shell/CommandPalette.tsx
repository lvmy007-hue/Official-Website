import { useEffect, useMemo, useRef, useState } from 'react'
import { Empty, Input, List, Modal, Typography } from 'antd'
import type { InputRef } from 'antd'
import { useAppNavigate } from '../nav/AppLink'
import { useNavGroups } from '../routes/live-context'
import { useSession } from '../session/session'
import { listObjectSearchers, type ObjectHit } from './object-search'

// 命令面板（P1-04）：Ctrl/⌘ + K 唤起，跳转页面与对象；↑↓ 选择、Enter 打开、Esc 关闭。

type Entry = { key: string; group: string; title: string; subtitle?: string; to: string }

/** 把关键词与页面标题、分组名做包含匹配（不区分大小写）。 */
export function filterPages(entries: Entry[], query: string): Entry[] {
  const text = query.trim().toLowerCase()
  if (!text) return entries
  return entries.filter(entry => `${entry.title} ${entry.group}`.toLowerCase().includes(text))
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [hits, setHits] = useState<Array<ObjectHit & { group: string }>>([])
  const input = useRef<InputRef>(null)
  const navigate = useAppNavigate()
  const groups = useNavGroups()
  const { canPermission } = useSession()

  const pages = useMemo<Entry[]>(() => groups.flatMap(group => group.items.map(item => ({ key: item.path, group: group.label, title: item.title, to: item.path }))), [groups])
  const pageResults = filterPages(pages, query).slice(0, 8)
  const objectResults: Entry[] = hits.map(hit => ({ key: `${hit.group}:${hit.id}`, group: hit.group, title: hit.title, subtitle: hit.subtitle, to: hit.to }))
  const results = [...pageResults, ...objectResults]

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    setHits([])
    const timer = window.setTimeout(() => input.current?.focus(), 50)
    return () => window.clearTimeout(timer)
  }, [open])

  // 对象搜索：输入至少 2 个字符才去服务端；新输入会取消上一次请求
  useEffect(() => {
    const text = query.trim()
    const searchers = listObjectSearchers(canPermission)
    if (!open || text.length < 2 || searchers.length === 0) {
      setHits([])
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void Promise.all(
        searchers.map(item =>
          item.search(text, controller.signal).then(
            list => list.map(hit => ({ ...hit, group: item.kind })),
            () => [],
          ),
        ),
      ).then(lists => {
        if (!controller.signal.aborted) setHits(lists.flat().slice(0, 8))
      })
    }, 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query, open, canPermission])

  const go = (entry: Entry | undefined) => {
    if (!entry) return
    onClose()
    navigate(entry.to)
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} closable={false} destroyOnClose width={560} styles={{ body: { padding: 0 } }} title={null} style={{ top: 96 }}>
      <Input
        ref={input}
        size="large"
        variant="borderless"
        placeholder="搜索页面或对象，例如：库存、订单号、ASIN"
        value={query}
        onChange={event => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActive(index => Math.min(index + 1, Math.max(results.length - 1, 0)))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive(index => Math.max(index - 1, 0))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            go(results[active])
          }
        }}
        aria-label="命令面板搜索"
      />
      <div style={{ borderTop: '1px solid var(--ant-color-border-secondary)', maxHeight: 360, overflow: 'auto' }}>
        {results.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的页面或对象" style={{ margin: '24px 0' }} />
        ) : (
          <List
            size="small"
            dataSource={results}
            renderItem={(entry, index) => (
              <List.Item
                key={entry.key}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(entry)}
                style={{ cursor: 'pointer', paddingInline: 16, background: index === active ? 'var(--ant-color-primary-bg)' : undefined }}
              >
                <span>{entry.title}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {entry.subtitle ? `${entry.group} · ${entry.subtitle}` : entry.group}
                </Typography.Text>
              </List.Item>
            )}
          />
        )}
      </div>
      <div style={{ padding: '6px 16px', borderTop: '1px solid var(--ant-color-border-secondary)', fontSize: 12, color: 'var(--ant-color-text-tertiary)' }}>↑↓ 选择 · Enter 打开 · Esc 关闭</div>
    </Modal>
  )
}
