import { useState } from 'react'
import { Button, InputNumber, Radio, Space } from 'antd'
import { ADS_WEEKDAY_LABEL, DAYPARTING_MULTIPLIER, gridIndexOf, neutralGrid, type DaypartingKind } from '@nova/api-contracts'
import { Muted } from '../inventory/inventory-ui'

// 168 格取值编辑器（P3-12）：先选“画笔”取值，再点格子填入；也可以点星期或小时的表头整行、整列填入。
// 启停策略的画笔只有“启用 / 暂停”；竞价系数策略的画笔是 0.1 至 3 的系数（最多两位小数）。受控组件，值是 168 个数（周一 0 点起）。

const cellText = (kind: DaypartingKind, value: number): string => (kind === 'ON_OFF' ? (value === 0 ? '停' : '开') : value === 1 ? '·' : value.toFixed(2).replace(/0$/, ''))
const cellColor = (kind: DaypartingKind, value: number): string => {
  if (value === 1) return '#fafafa'
  if (kind === 'ON_OFF') return 'rgba(255,77,79,0.35)'
  return value > 1 ? `rgba(22,119,255,${Math.min(0.75, 0.2 + (value - 1) * 0.3).toFixed(2)})` : `rgba(250,173,20,${Math.min(0.75, 0.2 + (1 - value) * 0.6).toFixed(2)})`
}

export function GridEditor({ kind, value, onChange }: { kind: DaypartingKind; value?: number[]; onChange?: (next: number[]) => void }) {
  const grid = value && value.length === 168 ? value : neutralGrid()
  const [brush, setBrush] = useState<number>(kind === 'ON_OFF' ? 0 : 1.2)
  // 类型从倍率改成启停（或反过来）时画笔取值要跟着合法
  const paint = kind === 'ON_OFF' ? (brush === 0 ? 0 : 1) : brush
  const apply = (indexes: number[]) => {
    const next = [...grid]
    for (const index of indexes) next[index] = paint
    onChange?.(next)
  }
  const column = (hour: number) => Array.from({ length: 7 }, (_, weekday) => gridIndexOf(weekday, hour))
  const row = (weekday: number) => Array.from({ length: 24 }, (_, hour) => gridIndexOf(weekday, hour))
  return (
    <div data-testid="dayparting-grid-editor">
      <Space style={{ marginBottom: 8 }} wrap>
        <span>画笔：</span>
        {kind === 'ON_OFF' ? (
          <Radio.Group
            aria-label="画笔取值"
            value={paint}
            onChange={event => setBrush(event.target.value as number)}
            options={[
              { value: 0, label: '暂停' },
              { value: 1, label: '启用' },
            ]}
          />
        ) : (
          <InputNumber
            aria-label="画笔取值"
            min={DAYPARTING_MULTIPLIER.min}
            max={DAYPARTING_MULTIPLIER.max}
            step={0.1}
            precision={2}
            value={brush}
            onChange={next => typeof next === 'number' && setBrush(next)}
          />
        )}
        <Button size="small" onClick={() => onChange?.(neutralGrid())}>
          全部恢复为不改变
        </Button>
        <Muted>{kind === 'ON_OFF' ? '格子里“停”是暂停、“开”是启用' : '格子里“·”是不改变（×1），其余是竞价系数'}</Muted>
      </Space>
      <div style={{ overflowX: 'auto' }}>
        <table aria-label="分时取值表" style={{ borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th />
              {Array.from({ length: 24 }, (_, hour) => (
                <th key={hour} style={{ padding: 0, fontWeight: 400 }}>
                  <Button type="text" size="small" style={{ padding: '0 2px', fontSize: 11, minWidth: 28 }} aria-label={`整列 ${hour} 时`} onClick={() => apply(column(hour))}>
                    {hour}
                  </Button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ADS_WEEKDAY_LABEL.map((label, weekday) => (
              <tr key={label}>
                <th style={{ padding: 0, fontWeight: 400 }}>
                  <Button type="text" size="small" style={{ fontSize: 11 }} aria-label={`整行 ${label}`} onClick={() => apply(row(weekday))}>
                    {label}
                  </Button>
                </th>
                {Array.from({ length: 24 }, (_, hour) => {
                  const index = gridIndexOf(weekday, hour)
                  const current = grid[index] ?? 1
                  return (
                    <td key={hour} style={{ border: '1px solid #f0f0f0', padding: 0 }}>
                      <button
                        type="button"
                        aria-label={`${label} ${hour} 时 ${kind === 'ON_OFF' ? (current === 0 ? '暂停' : '启用') : `系数 ${current}`}`}
                        onClick={() => apply([index])}
                        style={{ width: 28, height: 24, border: 0, cursor: 'pointer', fontSize: 11, background: cellColor(kind, current) }}
                      >
                        {cellText(kind, current)}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
