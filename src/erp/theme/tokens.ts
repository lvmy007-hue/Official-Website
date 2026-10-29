import type { Density } from '@nova/api-contracts'

// ERP 视觉令牌（15 章第 3 节，P6-01 落地）：Ant Design、AG Grid、ECharts 三套主题的唯一来源。
// 组件里不许直接写色值、阴影或像素魔数：色值与尺寸只能从这里或 Ant Design 的 CSS 变量取（样式守卫测试会扫描）。
// src/erp/erp.css 里的同名变量只用于校验两处一致（theme.test.ts）。
export const erpTokens = {
  brand: '#165dff',
  brandHover: '#4080ff',
  brandActive: '#0e42d2',
  brandSoft: '#e8f3ff',
  brandBorder: '#bedaff',

  ink: '#1d2129',
  inkSoft: '#4e5969',
  inkMute: '#86909c',
  inkFaint: '#c0c4cc',

  line: '#e5e6eb',
  lineSoft: '#f2f3f5',
  lineStrong: '#d9dbe0',

  canvas: '#ffffff',
  canvasSoft: '#f4f5f7',
  canvasSunk: '#f2f3f5',

  success: '#00b42a',
  successSoft: '#e8ffea',
  warning: '#ff7d00',
  warningSoft: '#fff7e8',
  danger: '#f53f3f',
  dangerSoft: '#ffece8',
  info: '#14c9c9',
  infoSoft: '#e8fffb',
  neutralSoft: '#f2f3f5',

  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
  fontSize: 13,
  /** 字号阶梯：辅助、正文、卡片标题、区块标题、页面标题、指标大数。 */
  fontSizes: { caption: 12, body: 13, cardTitle: 14, sectionTitle: 16, pageTitle: 18, metric: 20 },
  /** 间距阶梯，4 的倍数。 */
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 },

  /** 圆角：标签 2、控件 4、卡片与抽屉 6；不做胶囊与大圆角。 */
  radiusXs: 2,
  radiusSm: 4,
  radius: 6,

  /** 只给浮层（下拉、抽屉、弹窗、提示）用，卡片不加阴影。 */
  shadowPopup: '0 6px 20px rgba(0, 0, 0, 0.12)',

  // 表格行高：标准 40，紧凑 36（宽表默认，个人设置里切换）；表头 36
  rowHeight: 40,
  rowHeightCompact: 36,
  headerHeight: 36,
} as const

// 图表系列色板：第一色为主色，其余为辅助色。对比系列固定：本期用主色实线，上期 inkMute 虚线，去年同期 inkFaint 点线。
export const erpChartPalette = ['#165dff', '#14c9c9', '#f7ba1e', '#ff7d00', '#3491fa', '#00b42a', '#86909c'] as const

/** 密度对应的行高。 */
export const rowHeightOf = (density: Density): number => (density === 'COMPACT' ? erpTokens.rowHeightCompact : erpTokens.rowHeight)
