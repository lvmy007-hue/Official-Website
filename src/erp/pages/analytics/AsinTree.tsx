import { useState } from 'react'
import { Button, Checkbox, Empty, Space, Tag } from 'antd'
import { ASIN_COMPARE_MAX, asinSelectKey, type AsinTreeNode } from '@nova/api-contracts'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { AsinFigure } from './asin-analytics-ui'

// 父体树（04 章 4.6 左侧）：父体与单个 ASIN 按销售额从高到低排列，父体可展开看子体；勾选最多 5 个对象进入对比模式。
// 销售额与会话是所选日期范围内的合计（没有记录写“尚无记录”）；父体名称、子体名称点开看详情。

type Props = {
  nodes: readonly AsinTreeNode[]
  selected: readonly string[]
  onToggle: (key: string, checked: boolean) => void
}

function Numbers({ sales, sessions }: { sales: number | null; sessions: number | null }) {
  return (
    <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)', whiteSpace: 'nowrap' }}>
      销售额 <AsinFigure metric="sales" value={sales} /> · 会话 <AsinFigure metric="sessions" value={sessions} />
    </span>
  )
}

export function AsinTree({ nodes, selected, onToggle }: Props) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  if (nodes.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的父体或 ASIN" />
  const full = selected.length >= ASIN_COMPARE_MAX
  const toggleOpen = (key: string) =>
    setOpen(current => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  return (
    <div data-testid="asin-tree">
      {nodes.map(node => {
        const checked = selected.includes(node.key)
        const expanded = open.has(node.key)
        return (
          <div key={node.key} style={{ borderBottom: '1px solid var(--ant-color-border-secondary)', padding: '8px 0' }} data-testid="asin-tree-node">
            <Space align="start" size={8} style={{ width: '100%' }}>
              <Checkbox
                aria-label={`选择 ${node.asin}`}
                checked={checked}
                disabled={(checked && selected.length <= 1) || (!checked && full)}
                onChange={event => onToggle(node.key, event.target.checked)}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <Space size={6} wrap>
                  {node.kind === 'parent' ? (
                    <LiveLink component="ParentAsinDetailPage" id={node.asin}>
                      {node.title ?? `父体 ${node.asin}`}
                    </LiveLink>
                  ) : (
                    <span>{node.title ?? node.asin}</span>
                  )}
                  <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                    {node.kind === 'parent' ? `父体 · ${node.childCount} 个子体` : '单个 ASIN'}
                  </Tag>
                </Space>
                <div className="erp-num" style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)' }}>
                  {node.asin}
                  {node.brand ? ` · ${node.brand}` : ''}
                </div>
                <Numbers sales={node.sales} sessions={node.sessions} />
                {node.kind === 'parent' && node.children.length > 0 ? (
                  <div>
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0 }}
                      onClick={() => toggleOpen(node.key)}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? '收起' : '展开'} ${node.asin} 的子体`}
                    >
                      {expanded ? '收起子体' : '展开子体'}
                    </Button>
                  </div>
                ) : null}
              </div>
            </Space>
            {expanded
              ? node.children.map(child => {
                  const key = asinSelectKey({ kind: 'asin', asin: child.asin })
                  const childChecked = selected.includes(key)
                  return (
                    <div key={key} style={{ margin: '6px 0 0 28px' }} data-testid="asin-tree-child">
                      <Space align="start" size={8}>
                        <Checkbox
                          aria-label={`选择 ${child.asin}`}
                          checked={childChecked}
                          disabled={(childChecked && selected.length <= 1) || (!childChecked && full)}
                          onChange={event => onToggle(key, event.target.checked)}
                        />
                        <div>
                          {child.productId ? (
                            <LiveLink component="Asin360Page" id={child.productId}>
                              {child.title ?? child.asin}
                            </LiveLink>
                          ) : (
                            <span>{child.title ?? <Muted>目录里没有这个 ASIN</Muted>}</span>
                          )}
                          <div className="erp-num" style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)' }}>
                            {child.asin}
                          </div>
                          <Numbers sales={child.sales} sessions={child.sessions} />
                        </div>
                      </Space>
                    </div>
                  )
                })
              : null}
          </div>
        )
      })}
    </div>
  )
}
