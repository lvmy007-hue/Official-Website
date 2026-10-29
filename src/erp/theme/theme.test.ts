// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { theme } from 'antd'
import { erpAntdTheme, erpAntdThemeFor } from './antd-theme'
import { erpEchartsTheme } from './echarts-theme'
import { erpGridThemeFor } from './ag-grid-theme'
import { getDensity, setDensity } from './density'
import { erpChartPalette, erpTokens, rowHeightOf } from './tokens'

const erpCss = readFileSync(resolve(__dirname, '../erp.css'), 'utf8')
const cssVar = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(erpCss)?.[1]

describe('主题令牌', () => {
  it('颜色令牌与 erp.css 里的同名变量一致', () => {
    const pairs: Array<[keyof typeof erpTokens, string]> = [
      ['brand', 'erp-brand-500'],
      ['brandHover', 'erp-brand-400'],
      ['brandActive', 'erp-brand-600'],
      ['brandSoft', 'erp-brand-50'],
      ['brandBorder', 'erp-brand-100'],
      ['ink', 'erp-ink'],
      ['inkSoft', 'erp-ink-soft'],
      ['inkMute', 'erp-ink-mute'],
      ['inkFaint', 'erp-ink-faint'],
      ['line', 'erp-line'],
      ['lineSoft', 'erp-line-soft'],
      ['lineStrong', 'erp-line-strong'],
      ['canvas', 'erp-canvas'],
      ['canvasSoft', 'erp-canvas-soft'],
      ['canvasSunk', 'erp-canvas-sunk'],
      ['success', 'erp-success'],
      ['successSoft', 'erp-success-soft'],
      ['warning', 'erp-warning'],
      ['warningSoft', 'erp-warning-soft'],
      ['danger', 'erp-danger'],
      ['dangerSoft', 'erp-danger-soft'],
      ['info', 'erp-info'],
      ['infoSoft', 'erp-info-soft'],
      ['neutralSoft', 'erp-neutral-soft'],
    ]
    for (const [token, name] of pairs) expect(erpTokens[token], name).toBe(cssVar(name))
  })
  it('阶段 6 取值（15 章第 3 节）：主色、语义色、圆角、阴影、字号与间距阶梯', () => {
    expect(erpTokens.brand).toBe('#165dff')
    expect([erpTokens.success, erpTokens.warning, erpTokens.danger, erpTokens.info]).toEqual(['#00b42a', '#ff7d00', '#f53f3f', '#14c9c9'])
    expect([erpTokens.radiusXs, erpTokens.radiusSm, erpTokens.radius]).toEqual([2, 4, 6])
    expect(erpTokens.shadowPopup).toBe('0 6px 20px rgba(0, 0, 0, 0.12)')
    expect(Object.values(erpTokens.fontSizes)).toEqual([12, 13, 14, 16, 18, 20])
    expect(Object.values(erpTokens.space).every(value => value % 4 === 0)).toBe(true)
    expect(erpTokens.fontSize).toBe(erpTokens.fontSizes.body)
  })
  it('密度：标准 40、紧凑 36，表头 36', () => {
    expect(rowHeightOf('STANDARD')).toBe(40)
    expect(rowHeightOf('COMPACT')).toBe(36)
    expect(erpTokens.headerHeight).toBe(36)
  })
})

describe('Ant Design 主题', () => {
  it('启用紧凑算法并使用主色与圆角令牌', () => {
    expect(erpAntdTheme.algorithm).toBe(theme.compactAlgorithm)
    expect(erpAntdTheme.token?.colorPrimary).toBe('#165dff')
    expect(erpAntdTheme.token?.borderRadius).toBe(4)
    expect(erpAntdTheme.token?.borderRadiusLG).toBe(6)
  })
  it('两种密度下表格行高分别是 40 与 36 像素（行高 20 加上下内边距加 1 像素分隔线）', () => {
    const lineHeightPx = Math.round(erpTokens.fontSize * 1.5715)
    const rowOf = (density: 'COMPACT' | 'STANDARD') => {
      const padding = Number((erpAntdThemeFor(density).components?.Table as { cellPaddingBlock?: number }).cellPaddingBlock)
      return lineHeightPx + padding * 2 + 1
    }
    expect(rowOf('STANDARD')).toBe(40)
    expect(rowOf('COMPACT')).toBe(36)
  })
})

describe('AG Grid 主题', () => {
  it('两种密度各自一份，切换不重新构造', () => {
    expect(erpGridThemeFor('COMPACT')).toBe(erpGridThemeFor('COMPACT'))
    expect(erpGridThemeFor('COMPACT')).not.toBe(erpGridThemeFor('STANDARD'))
  })
})

describe('密度状态', () => {
  it('切换后立即生效并写入本机缓存；相同值不重复通知', () => {
    const before = getDensity()
    try {
      setDensity('COMPACT')
      expect(getDensity()).toBe('COMPACT')
      expect(localStorage.getItem('nova.erp.density')).toBe('COMPACT')
      setDensity('STANDARD')
      expect(getDensity()).toBe('STANDARD')
    } finally {
      setDensity(before)
    }
  })
})

describe('ECharts 主题', () => {
  it('第一系列色为主色，色板取阶段 6 取值', () => {
    expect(erpEchartsTheme.color[0]).toBe(erpTokens.brand)
    expect([...erpChartPalette]).toEqual(['#165dff', '#14c9c9', '#f7ba1e', '#ff7d00', '#3491fa', '#00b42a', '#86909c'])
  })
  it('提示框阴影用浮层阴影令牌', () => {
    expect(erpEchartsTheme.tooltip.extraCssText).toContain(erpTokens.shadowPopup)
  })
})
