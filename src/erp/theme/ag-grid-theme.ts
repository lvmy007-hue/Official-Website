import {
  ClientSideRowModelModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  CellStyleModule,
  EventApiModule,
  InfiniteRowModelModule,
  LocaleModule,
  ModuleRegistry,
  PinnedRowModule,
  RenderApiModule,
  RowApiModule,
  RowAutoHeightModule,
  RowSelectionModule,
  RowStyleModule,
  TooltipModule,
  themeQuartz,
} from 'ag-grid-community'
import type { Density } from '@nova/api-contracts'
import { erpTokens as t, rowHeightOf } from './tokens'

let registered = false

// 只注册用到的模块，不使用 AllCommunityModule，避免整体打包。
// 海量表格走无限滚动行模型（服务端游标分页）；客户端行模型只给少量局部场景。
export function registerErpGridModules() {
  if (registered) return
  registered = true
  ModuleRegistry.registerModules([
    InfiniteRowModelModule,
    ClientSideRowModelModule,
    ColumnApiModule,
    ColumnAutoSizeModule,
    CellStyleModule,
    RowStyleModule,
    RowSelectionModule,
    PinnedRowModule,
    TooltipModule,
    RenderApiModule,
    RowApiModule,
    RowAutoHeightModule,
    EventApiModule,
    LocaleModule,
  ])
}

// AG Grid 主题：与 Ant Design 主题同一套令牌；行高随密度变化（紧凑 36、标准 40），表头 36。
function buildGridTheme(density: Density) {
  return themeQuartz.withParams({
    accentColor: t.brand,
    backgroundColor: t.canvas,
    foregroundColor: t.ink,
    borderColor: t.line,
    headerBackgroundColor: t.canvasSoft,
    headerTextColor: t.inkSoft,
    rowHoverColor: t.canvasSoft,
    selectedRowBackgroundColor: t.brandSoft,
    fontFamily: t.fontFamily,
    fontSize: t.fontSize,
    headerFontSize: t.fontSize,
    headerFontWeight: 500,
    rowHeight: rowHeightOf(density),
    headerHeight: t.headerHeight,
    // 汇总行（钉在表头下方）与固定列的分隔：浅底、半粗体、细线
    pinnedRowBackgroundColor: t.canvasSoft,
    pinnedRowFontWeight: 600,
    pinnedRowBorder: { style: 'solid', width: 1, color: t.lineStrong },
    pinnedColumnBorder: { style: 'solid', width: 1, color: t.line },
    wrapperBorderRadius: t.radius,
    browserColorScheme: 'light',
  })
}

const GRID_THEMES = { COMPACT: buildGridTheme('COMPACT'), STANDARD: buildGridTheme('STANDARD') }

/** 按密度取表格主题。 */
export const erpGridThemeFor = (density: Density) => GRID_THEMES[density]

/** 标准密度的表格主题（默认）。 */
export const erpGridTheme = GRID_THEMES.STANDARD
// 中文文案（仅覆盖当前注册模块会用到的文字）。
export const erpGridLocaleText: Record<string, string> = {
  loadingOoo: '加载中…',
  noRowsToShow: '没有可显示的数据',
  selectAll: '全选',
  searchOoo: '搜索…',
  blanks: '空值',
  ariaSortableColumn: '按回车键排序',
  ariaToggleRowSelection: '按空格键选择行',
  ariaRowSelect: '按空格键选择此行',
  ariaRowDeselect: '按空格键取消选择此行',
  ariaColumnHeader: '列标题',
}
