import { theme, type ThemeConfig } from 'antd'
import type { Density } from '@nova/api-contracts'
import { erpTokens as t, rowHeightOf } from './tokens'

// Ant Design 5 主题：紧凑算法 + 令牌（15 章第 3 节）。
// 所有外观调整只能改这里，不允许在页面里手写基础组件样式。密度（紧凑 36、标准 40）只影响表格行高。

/** 正文行高约 20 像素，加 1 像素行分隔线；上下内边距按行高反推。 */
const TABLE_LINE_BOX = 21

export function buildErpAntdTheme(density: Density): ThemeConfig {
  return {
    algorithm: theme.compactAlgorithm,
    // 以 CSS 变量输出令牌，工具类与 AG Grid 可共用同一份色值
    cssVar: true,
    token: {
      colorPrimary: t.brand,
      colorPrimaryHover: t.brandHover,
      colorPrimaryActive: t.brandActive,
      colorPrimaryBg: t.brandSoft,
      colorPrimaryBorder: t.brandBorder,
      colorInfo: t.brand,
      colorSuccess: t.success,
      colorWarning: t.warning,
      colorError: t.danger,
      colorLink: t.brand,
      colorText: t.ink,
      colorTextSecondary: t.inkSoft,
      colorTextTertiary: t.inkMute,
      colorTextQuaternary: t.inkFaint,
      colorBorder: t.lineStrong,
      colorBorderSecondary: t.line,
      colorBgLayout: t.canvasSoft,
      colorBgContainer: t.canvas,
      colorFillAlter: t.canvasSoft,
      fontFamily: t.fontFamily,
      fontSize: t.fontSize,
      fontSizeSM: t.fontSizes.caption,
      fontSizeLG: t.fontSizes.cardTitle,
      fontSizeHeading5: t.fontSizes.cardTitle,
      fontSizeHeading4: t.fontSizes.sectionTitle,
      fontSizeHeading3: t.fontSizes.pageTitle,
      borderRadius: t.radiusSm,
      borderRadiusSM: t.radiusXs,
      borderRadiusLG: t.radius,
      boxShadow: t.shadowPopup,
      boxShadowSecondary: t.shadowPopup,
      wireframe: false,
      motion: true,
    },
    components: {
      Table: {
        cellPaddingBlock: (rowHeightOf(density) - TABLE_LINE_BOX) / 2,
        cellPaddingInline: t.space.md,
        headerBg: t.canvasSoft,
        headerColor: t.inkSoft,
        borderColor: t.line,
        rowHoverBg: t.brandSoft,
      },
      Card: { headerHeight: 40, paddingLG: t.space.lg },
      Statistic: { contentFontSize: t.fontSizes.metric },
      Layout: { headerBg: t.canvas, siderBg: t.canvas, bodyBg: t.canvasSoft },
      Menu: { itemHeight: 36, itemSelectedBg: t.brandSoft, itemSelectedColor: t.brand },
    },
  }
}

const THEMES: Record<Density, ThemeConfig> = { COMPACT: buildErpAntdTheme('COMPACT'), STANDARD: buildErpAntdTheme('STANDARD') }

/** 按密度取主题（两份预先建好，切换时不重新计算）。 */
export const erpAntdThemeFor = (density: Density): ThemeConfig => THEMES[density]

/** 标准密度的主题（默认）。 */
export const erpAntdTheme: ThemeConfig = THEMES.STANDARD
