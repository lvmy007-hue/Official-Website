import { describe, expect, it } from 'vitest'
import { appendWidget, emptyLayout, moveItem, parseLayout, resizeItem } from './custom-dashboard'

describe('仪表盘网格布局', () => {
  it('拒绝越出 12 列、重复组件和小数坐标', () => {
    expect(parseLayout({ items: [{ widgetId: 'a', x: 10, y: 0, w: 3, h: 2 }] })).toBeNull()
    expect(
      parseLayout({
        items: [
          { widgetId: 'a', x: 0, y: 0, w: 2, h: 2 },
          { widgetId: 'a', x: 2, y: 0, w: 2, h: 2 },
        ],
      }),
    ).toBeNull()
    expect(parseLayout({ items: [{ widgetId: 'a', x: 0.5, y: 0, w: 2, h: 2 }] })).toBeNull()
  })

  it('新组件排在已有内容下面；移动和缩放不越过网格', () => {
    const layout = appendWidget(appendWidget(emptyLayout(), 'a', 'METRIC_CARD'), 'b', 'LINE')
    expect(layout.items.map(item => item.y)).toEqual([0, 2])
    const moved = moveItem(layout, 'a', 20, -3)
    expect(moved.items[0]).toMatchObject({ x: 9, y: 0, w: 3 })
    const resized = resizeItem(moved, 'a', 8, 1)
    expect(resized.items[0]).toMatchObject({ w: 3, h: 1 })
  })
})
