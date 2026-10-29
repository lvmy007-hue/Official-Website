// 自定义仪表盘（P6-33）。零 zod：页面可以引用。请求校验在 custom-dashboard-query.ts。
// 画布是 12 列网格。不引入第三方拖拽库，拖拽与缩放在页面里用指针事件完成。

export const DASHBOARD_COLS = 12
export const DASHBOARD_WIDGET_MAX = 24
export const DASHBOARD_MAX = 50
export const DASHBOARD_FOLDER_MAX = 50
export const DASHBOARD_REFRESH_MIN = 5
export const DASHBOARD_REFRESH_MAX = 1440
export const DASHBOARD_NAME_MAX = 40
export const DASHBOARD_TEXT_MAX = 2000
export const DASHBOARD_WRITE = 'dashboard.write'
export const DASHBOARD_SHARE = 'dashboard.share'

export const WIDGET_TYPES = ['METRIC_CARD', 'LINE', 'BAR', 'HORIZONTAL_BAR', 'PIE', 'TABLE', 'TEXT'] as const
export type WidgetType = (typeof WIDGET_TYPES)[number]

export const WIDGET_TYPE_LABEL: Readonly<Record<WidgetType, string>> = {
  METRIC_CARD: '指标卡',
  LINE: '折线图',
  BAR: '柱状图',
  HORIZONTAL_BAR: '条形图',
  PIE: '饼图',
  TABLE: '表格',
  TEXT: '文本',
}

export function isWidgetType(value: string): value is WidgetType {
  return (WIDGET_TYPES as readonly string[]).includes(value)
}

export interface LayoutItem {
  widgetId: string
  x: number
  y: number
  w: number
  h: number
}

export interface DashboardLayout {
  items: LayoutItem[]
}

export const emptyLayout = (): DashboardLayout => ({ items: [] })

const integerIn = (value: unknown, min: number, max: number): number | null => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return null
  return value
}

/** 布局不合法时返回 null。列不超过 12，同一组件只能出现一次。 */
export function parseLayout(value: unknown): DashboardLayout | null {
  if (!value || typeof value !== 'object' || !('items' in value)) return null
  const items = (value as { items: unknown }).items
  if (!Array.isArray(items) || items.length > DASHBOARD_WIDGET_MAX) return null
  const parsed: LayoutItem[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    const widgetId = typeof row.widgetId === 'string' ? row.widgetId.trim() : ''
    const x = integerIn(row.x, 0, DASHBOARD_COLS - 1)
    const y = integerIn(row.y, 0, 200)
    const w = integerIn(row.w, 1, DASHBOARD_COLS)
    const h = integerIn(row.h, 1, 20)
    if (!widgetId || widgetId.length > 40 || x === null || y === null || w === null || h === null) return null
    if (x + w > DASHBOARD_COLS) return null
    parsed.push({ widgetId, x, y, w, h })
  }
  if (new Set(parsed.map(item => item.widgetId)).size !== parsed.length) return null
  return { items: parsed }
}

export function defaultSpan(type: WidgetType): { w: number; h: number } {
  if (type === 'METRIC_CARD') return { w: 3, h: 2 }
  if (type === 'TEXT') return { w: 6, h: 2 }
  if (type === 'TABLE') return { w: 12, h: 5 }
  return { w: 6, h: 4 }
}

export function appendWidget(layout: DashboardLayout, widgetId: string, type: WidgetType): DashboardLayout {
  const span = defaultSpan(type)
  const y = layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0)
  return { items: [...layout.items, { widgetId, x: 0, y, w: span.w, h: span.h }] }
}

export function dropWidget(layout: DashboardLayout, widgetId: string): DashboardLayout {
  return { items: layout.items.filter(item => item.widgetId !== widgetId) }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function moveItem(layout: DashboardLayout, widgetId: string, x: number, y: number): DashboardLayout {
  return {
    items: layout.items.map(item => (item.widgetId === widgetId ? { ...item, x: clamp(x, 0, DASHBOARD_COLS - item.w), y: Math.max(0, y) } : item)),
  }
}

export function resizeItem(layout: DashboardLayout, widgetId: string, w: number, h: number): DashboardLayout {
  return {
    items: layout.items.map(item => {
      if (item.widgetId !== widgetId) return item
      const width = clamp(w, 1, DASHBOARD_COLS - item.x)
      return { ...item, w: width, h: clamp(h, 1, 20) }
    }),
  }
}
