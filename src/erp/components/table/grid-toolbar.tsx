import { useState, type ReactNode } from 'react'
import { Badge, Button, Checkbox, Collapse, Dropdown, Space, Tag, Tooltip, Typography } from 'antd'
import { PushpinOutlined, PushpinFilled } from '@ant-design/icons'
import { columnPanelModel } from './grid-columns'
import { FilterSchemesMenu } from './filter-schemes-menu'
import { GridViewsMenu } from './grid-views-menu'
import { columnId, type ErpColDef } from './grid-types'
import type { FilterSchemesApi } from './use-filter-schemes'
import type { GridViewsApi } from './use-grid-views'

// 表格工具栏（P6-02 从 MassiveGrid 拆出，无限滚动与页码分页共用）：
// 已应用条件数、行数、视图（P6-03：服务端保存的我的 / 团队 / 系统视图）、对比、列设置（按组折叠，可固定到左侧）、导出、批量动作栏。
// 没有接口支撑的功能（导出）不传对应属性就不显示，不做假按钮。

export const COMPARE_MIN = 2
export const COMPARE_MAX = 5

export type PinProps = { pinned: Readonly<Record<string, 'left' | 'right'>>; onChange: (id: string, side: 'left' | null) => void }

/** 列设置面板：没有分组的列平铺；有分组的按组折叠，组标题上的勾选框整组显示或隐藏。至少保留一列可见。 */
export function ColumnMenu<T>({
  columns,
  hidden,
  onChange,
  pin,
}: {
  columns: readonly ErpColDef<T>[]
  hidden: readonly string[]
  onChange: (ids: string[], visible: boolean) => void
  pin?: PinProps
}) {
  const model = columnPanelModel<T>(columns)
  const visibleCount = columns.filter(col => !hidden.includes(columnId(col))).length
  const only = (id: string) => visibleCount <= 1 && !hidden.includes(id)
  const pageFixed = new Set(columns.filter(col => col.pin).map(columnId))
  const item = (entry: { id: string; label: string }) => (
    <div key={entry.id} className="erp-grid-menu-item">
      <Checkbox checked={!hidden.includes(entry.id)} disabled={only(entry.id)} onChange={event => onChange([entry.id], event.target.checked)}>
        {entry.label}
      </Checkbox>
      {pin && !pageFixed.has(entry.id) ? (
        <Tooltip title={pin.pinned[entry.id] ? '取消固定' : '固定到左侧'}>
          <Button
            type="text"
            size="small"
            aria-label={`${pin.pinned[entry.id] ? '取消固定' : '固定到左侧'}：${entry.label}`}
            aria-pressed={Boolean(pin.pinned[entry.id])}
            icon={pin.pinned[entry.id] ? <PushpinFilled /> : <PushpinOutlined />}
            onClick={() => pin.onChange(entry.id, pin.pinned[entry.id] ? null : 'left')}
          />
        </Tooltip>
      ) : null}
    </div>
  )
  return (
    <div className="erp-grid-menu" role="group" aria-label="列设置">
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        {model.ungrouped.map(item)}
      </Space>
      {model.groups.length ? (
        <Collapse
          ghost
          size="small"
          items={model.groups.map(group => {
            const shown = group.items.filter(entry => !hidden.includes(entry.id)).length
            const ids = group.items.map(entry => entry.id)
            return {
              key: group.name,
              label: (
                <Checkbox
                  aria-label={`整组显示：${group.name}`}
                  checked={shown === ids.length}
                  indeterminate={shown > 0 && shown < ids.length}
                  onClick={event => event.stopPropagation()}
                  onChange={event => onChange(ids, event.target.checked)}
                >
                  {group.name}（{shown}/{ids.length}）
                </Checkbox>
              ),
              children: (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {group.items.map(item)}
                </Space>
              ),
            }
          })}
        />
      ) : null}
    </div>
  )
}

export type GridToolbarProps<T extends object> = {
  columns: readonly ErpColDef<T>[]
  hidden: string[]
  onVisibilityChange: (ids: string[], visible: boolean) => void
  pin?: PinProps
  appliedFilterCount: number
  onClearFilters?: () => void
  /** 行数说明，例如“约 3 行”或“共 45 行”；不知道就不传。 */
  countLabel?: string | null
  extra?: ReactNode
  /** 汇总读取失败时的提示（带重试）。 */
  summaryNotice?: ReactNode
  /** 服务端视图（P6-03）；不传表示这个表格没有开启视图。 */
  views?: GridViewsApi | null
  /** 筛选方案（P6-04）；不传表示没有。 */
  schemes?: FilterSchemesApi | null
  selected: T[]
  onCompare?: (rows: T[]) => void
  onExport?: () => Promise<void> | void
  exportDisabledReason?: string
}

export function GridToolbar<T extends object>(props: GridToolbarProps<T>) {
  const [exporting, setExporting] = useState(false)
  const runExport = async () => {
    if (!props.onExport) return
    setExporting(true)
    try {
      await props.onExport()
    } finally {
      setExporting(false)
    }
  }
  const count = props.selected.length
  const compareReason = count < COMPARE_MIN ? `请先勾选 ${COMPARE_MIN} 至 ${COMPARE_MAX} 个对象` : count > COMPARE_MAX ? `一次最多对比 ${COMPARE_MAX} 个对象` : null
  return (
    <div className="erp-grid-toolbar">
      <Space size={8} wrap>
        <Badge count={props.appliedFilterCount} size="small" color="var(--ant-color-primary)" offset={[4, 0]} overflowCount={99}>
          <Typography.Text type="secondary">已应用 {props.appliedFilterCount} 个条件</Typography.Text>
        </Badge>
        {props.appliedFilterCount > 0 && props.onClearFilters ? (
          <Button type="link" size="small" onClick={props.onClearFilters}>
            清除条件
          </Button>
        ) : null}
        {props.countLabel ? <Tag bordered={false}>{props.countLabel}</Tag> : null}
        {props.summaryNotice}
        {props.extra}
      </Space>
      <Space size={8} wrap>
        {props.schemes ? <FilterSchemesMenu schemes={props.schemes} /> : null}
        {props.views ? <GridViewsMenu views={props.views} /> : null}
        {props.onCompare ? (
          <Tooltip title={compareReason ?? undefined}>
            <span>
              <Button disabled={compareReason !== null} onClick={() => props.onCompare?.(props.selected)}>
                对比所选{count ? `（${count}）` : ''}
              </Button>
            </span>
          </Tooltip>
        ) : null}
        <Dropdown trigger={['click']} popupRender={() => <ColumnMenu columns={props.columns} hidden={props.hidden} onChange={props.onVisibilityChange} pin={props.pin} />}>
          <Button>列设置</Button>
        </Dropdown>
        {props.onExport ? (
          <Button loading={exporting} onClick={runExport}>
            导出
          </Button>
        ) : props.exportDisabledReason ? (
          <Tooltip title={props.exportDisabledReason}>
            <span>
              <Button disabled>导出</Button>
            </span>
          </Tooltip>
        ) : null}
      </Space>
    </div>
  )
}

/** 勾选后出现在表格底部的白底操作条（15 章第 6 节：不用深色或主色底）。 */
export function BulkBar({ count, children }: { count: number; children: ReactNode }) {
  if (count === 0) return null
  return (
    <div role="toolbar" aria-label="批量操作" className="erp-grid-bulkbar">
      <span>已选 {count} 项</span>
      {children}
    </div>
  )
}
