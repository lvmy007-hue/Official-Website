import { Card, DatePicker, Empty, Space, Typography } from 'antd'
import dayjs from 'dayjs'
import { DataState } from '../data-state/DataState'
import { diffSnapshots } from './analysis'
import { SimpleGrid } from '../table/SimpleGrid'

// 历史快照对比（03 章 3.4 第 9 项）：任选两个日期对比对象状态——刊登内容字段级差异、价格、库存结构、广告设置。
// 日期由页面控制并取回两份快照；这里只负责字段级差异展示（只显示有中文名称的字段）。

export type SnapshotDiffProps = {
  title: string
  /** 可选日期范围内有快照的日期（YYYY-MM-DD）；其余日期不可选。 */
  availableDates: readonly string[]
  dates: [string | null, string | null]
  onDatesChange: (dates: [string | null, string | null]) => void
  /** 两份快照；日期未选全或尚未取回时为 undefined。 */
  snapshots?: [Record<string, unknown>, Record<string, unknown>]
  loading?: boolean
  /** 字段 → 中文名称；没有名称的内部字段不展示。 */
  labels: Readonly<Record<string, string>>
}

export function SnapshotDiff(props: SnapshotDiffProps) {
  const available = new Set(props.availableDates)
  const [a, b] = props.dates
  const changes = props.snapshots ? diffSnapshots(props.snapshots[0], props.snapshots[1], props.labels) : null
  return (
    <Card size="small" title={props.title} data-testid="snapshot-diff">
      <Space style={{ marginBottom: 8 }} wrap>
        <span>对比</span>
        <DatePicker
          aria-label="较早日期"
          value={a ? dayjs(a) : null}
          disabledDate={date => !available.has(date.format('YYYY-MM-DD'))}
          onChange={value => props.onDatesChange([value ? value.format('YYYY-MM-DD') : null, b])}
        />
        <span>与</span>
        <DatePicker
          aria-label="较晚日期"
          value={b ? dayjs(b) : null}
          disabledDate={date => !available.has(date.format('YYYY-MM-DD'))}
          onChange={value => props.onDatesChange([a, value ? value.format('YYYY-MM-DD') : null])}
        />
      </Space>
      {props.availableDates.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有历史快照；同步任务运行后会按日留存" />
      ) : props.loading ? (
        <DataState kind="skeleton" rows={3} />
      ) : !changes ? (
        <Typography.Text type="secondary">请选择两个有快照的日期</Typography.Text>
      ) : changes.length === 0 ? (
        <Typography.Text>两个日期之间没有差异</Typography.Text>
      ) : (
        <SimpleGrid
          gridId="insight.snapshot-diff"
          columns={[
            { title: '项目', dataIndex: 'label', width: 140 },
            { title: a ?? '较早', dataIndex: 'before', render: (value: string) => <span style={{ textDecoration: 'line-through', color: 'var(--ant-color-text-secondary)' }}>{value}</span> },
            { title: b ?? '较晚', dataIndex: 'after' },
          ]}
          rows={changes}
          rowKey={row => row.key}
          emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
        />
      )}
    </Card>
  )
}
