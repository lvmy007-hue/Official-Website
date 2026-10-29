import { Descriptions } from 'antd'
import type { FeeAuditDims, FeeAuditEvidenceLine, FeeAuditRow, SizeCm } from '@nova/api-contracts'
import { Muted } from '../inventory/inventory-ui'
import { money, timeText } from '../orders/orders-ui'
import { SimpleGrid } from '../../components'

// 费用核查的展开内容（07 章 7.6）：核查依据说明、多收的明细（应收与实收）、尺寸与重量对比、核对时遇到的限制。
// 每个数字都能在这里看到出处；没有的部分写明原因，不留空白。

const cm = (value: number) => `${(Math.round(value * 10) / 10).toString()}`
const sides = (size: SizeCm | null) => (size ? `${cm(size.longestCm)} × ${cm(size.medianCm)} × ${cm(size.shortestCm)} cm` : null)
const weight = (value: number | null | undefined) => (value === null || value === undefined ? '' : `，${value} kg`)
const percent = (value: number | null) => (value === null ? '无法计算' : `${Math.round(value * 1000) / 10}%`)

function Dims({ dims }: { dims: FeeAuditDims }) {
  const amazon = dims.amazon ? `${sides(dims.amazon)}${weight(dims.amazon.weightKg)}` : null
  const ours = dims.ours ? `${sides(dims.ours)}${weight(dims.ours.weightKg)}` : null
  return (
    <Descriptions size="small" column={1} bordered={false} style={{ marginBottom: 8 }}>
      <Descriptions.Item label="亚马逊测量">{amazon ?? <Muted>没有亚马逊测量的尺寸</Muted>}</Descriptions.Item>
      <Descriptions.Item label="我方登记">{ours ?? <Muted>没有登记尺寸，无法对比</Muted>}</Descriptions.Item>
      <Descriptions.Item label="体积比（亚马逊 ÷ 我方）">{percent(dims.volumeRatio)}</Descriptions.Item>
      <Descriptions.Item label="单边最大相对差">{percent(dims.maxSideDelta)}</Descriptions.Item>
      <Descriptions.Item label="尺寸分段">
        {dims.tierAmazon ?? '未知'}
        {dims.tierPrevious ? `（上次 ${dims.tierPrevious}）` : ''}
        {dims.tierOurs ? `；按我方尺寸估计 ${dims.tierOurs}` : ''}
      </Descriptions.Item>
    </Descriptions>
  )
}

export function FeeAuditBasis({ row }: { row: FeeAuditRow }) {
  const { basis } = row
  const columns = [
    { title: '时间', dataIndex: 'at', width: 160, render: (value: string | null) => (value ? timeText(value) : <Muted>无</Muted>) },
    { title: '单号 / 月份', dataIndex: 'ref', width: 190, render: (value: string | null) => (value ? <span className="erp-num">{value}</span> : <Muted>无</Muted>) },
    { title: '说明', dataIndex: 'label' },
    { title: '数量', dataIndex: 'quantity', width: 70, align: 'right' as const, render: (value: number | null) => (value === null ? <Muted>未知</Muted> : value) },
    { title: '应收', dataIndex: 'expected', width: 100, align: 'right' as const, render: (value: number) => money(value, row.currency) },
    { title: '实收', dataIndex: 'actual', width: 100, align: 'right' as const, render: (value: number) => money(value, row.currency) },
    { title: '多收', dataIndex: 'diff', width: 100, align: 'right' as const, render: (value: number) => money(value, row.currency) },
  ]
  return (
    <div style={{ padding: '4px 0' }}>
      <p style={{ margin: '0 0 8px' }}>{basis.summary || <Muted>没有依据说明</Muted>}</p>
      {basis.dims ? <Dims dims={basis.dims} /> : null}
      {basis.lines.length > 0 ? (
        <SimpleGrid<FeeAuditEvidenceLine>
          gridId="finance.fee-audit-basis"
          columns={columns}
          rows={basis.lines}
          rowKey={line => `${line.label}|${basis.lines.indexOf(line)}`}
          emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
        />
      ) : (
        <Muted>没有多收的明细行；可能只是汇总层面的差异</Muted>
      )}
      {basis.notes.length > 0 ? (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: 'rgba(0,0,0,0.65)' }}>
          {basis.notes.map(note => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
