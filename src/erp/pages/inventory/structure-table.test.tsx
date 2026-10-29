import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { StructurePoint } from '@nova/api-contracts'
import { renderWithApp } from '../../test/render'
import { StructureTable } from './structure-table'

// 库存结构每日明细表与趋势图联动（P6-06）：图上点选的日期传进来后只显示那一天，可以清除。

const points: StructurePoint[] = [
  { date: '2026-10-20', source: 'API', sellable: 100, inbound: 10, reserved: 2, unsellable: 1, researching: 0 },
  { date: '2026-10-21', source: 'AFN', sellable: 90, inbound: null, reserved: 2, unsellable: 1, researching: 0 },
]

describe('库存结构每日明细表', () => {
  it('没有点选日期：显示全部并提示怎么联动；缺失的数量显示“—”，来源显示中文', async () => {
    renderWithApp(<StructureTable points={points} filterDate={null} onRowFocus={vi.fn()} onClear={vi.fn()} />)
    expect(await screen.findByText('2026-10-21')).toBeInTheDocument()
    expect(screen.getByText('共 2 条')).toBeInTheDocument()
    expect(screen.getByText('亚马逊物流库存报告')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByText(/在趋势图上点某一天/)).toBeInTheDocument()
  })

  it('图上点选了某一天：只显示那一天，标签可以清除', async () => {
    const onClear = vi.fn()
    renderWithApp(<StructureTable points={points} filterDate="2026-10-20" onRowFocus={vi.fn()} onClear={onClear} />)
    expect(await screen.findByText('2026-10-20')).toBeInTheDocument()
    expect(screen.getByText('共 1 条')).toBeInTheDocument()
    expect(screen.queryByText('2026-10-21')).toBeNull()
    await userEvent.click(screen.getByRole('img', { name: /关\s*闭|close/i }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('点选的日期没有数据（图上那天缺记录）：给空状态而不是空表', async () => {
    renderWithApp(<StructureTable points={points} filterDate="2026-10-25" onRowFocus={vi.fn()} onClear={vi.fn()} />)
    expect(await screen.findByText('每日库存明细')).toBeInTheDocument()
    expect(screen.queryByText(/共 \d+ 条/)).toBeNull()
  })
})
