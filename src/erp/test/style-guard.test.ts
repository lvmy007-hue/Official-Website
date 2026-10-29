import { describe, expect, it } from 'vitest'
import { isScanned, listSources, scanAll, scanSource } from './style-guard'

// 样式守卫（P6-01，15 章 2.3）：src/erp 下的界面代码不许出现渐变、毛玻璃、表情符号，也不许在令牌文件以外写十六进制色值。
// 渐变、毛玻璃、表情符号：现在为零，任何新增都失败。
// 十六进制色值：阶段 6 开始时已有 40 个文件共 108 处历史写法（多是图表配色与旧页面）。它们登记在下面的“存量基线”里，
// 只许减少不许增加（新增文件或新增处数都失败）；每个界面包改版时把对应文件改成引用令牌，并同步下调这里的数字。
// 反向用例保证守卫本身没有失效。

const HEX_BASELINE: Record<string, number> = {
  'pages/advertising/AdsPortfoliosPage.tsx': 1,
  'pages/advertising/AdsProductsPage.tsx': 1,
  'pages/advertising/ad-terms-options.ts': 4,
  'pages/advertising/ads-campaign-tabs-more.tsx': 2,
  'pages/advertising/ads-dayparting-grid.tsx': 2,
  'pages/advertising/ads-dayparting-heatmap.tsx': 2,
  'pages/advertising/ads-options.ts': 4,
  'pages/advertising/ads-products-columns.tsx': 1,
  'pages/analytics/BrandMarketBasketPage.tsx': 1,
  'pages/analytics/BrandRepeatPurchasePage.tsx': 1,
  'pages/analytics/asin-analytics-options.ts': 11,
  'pages/analytics/brand-options.ts': 11,
  'pages/analytics/business-reports-options.ts': 3,
  'pages/aplus/AplusDetailParts.tsx': 1,
  'pages/aplus/AplusEditorDrawer.tsx': 1,
  'pages/aplus/AplusModuleForms.tsx': 1,
  'pages/aplus/AplusModulePreview.tsx': 2,
  'pages/aplus/aplus-columns.tsx': 1,
  'pages/connections/RoleComparison.tsx': 1,
  'pages/connections/subscription-columns.tsx': 1,
  'pages/costs/costs-forms.tsx': 1,
  'pages/costs/costs-ui.tsx': 4,
  'pages/economics/economics-ui.tsx': 1,
  'pages/finance/cashflow-ui.tsx': 1,
  'pages/finance/sales-tax-options.ts': 2,
  'pages/inventory/LimitImportAction.tsx': 1,
  'pages/inventory/detail-tabs-age-forecast.tsx': 1,
  'pages/overview/waterfall-option.ts': 3,
  'pages/profit/OverviewTab.tsx': 2,
  'pages/profit/profit-options.ts': 6,
  'pages/profit/profit-ui.tsx': 1,
  'pages/replenishment/simulation-chart.ts': 4,
  'pages/reviews/RatingsImportModal.tsx': 2,
  'pages/reviews/RatingsPanel.tsx': 1,
  'pages/subscribe-save/subscribe-save-options.ts': 3,
  'pages/sync/SyncDomainCards.tsx': 5,
}

describe('样式守卫：真实代码', () => {
  const all = scanAll()
  const hexByFile = new Map<string, number>()
  for (const item of all) if (item.rule === 'hex') hexByFile.set(item.file, (hexByFile.get(item.file) ?? 0) + 1)

  it('扫描到了足够多的界面文件（守卫没有因为路径问题扫空）', () => {
    const files = listSources()
    expect(files.length).toBeGreaterThan(300)
    expect(files).toContain('shell/AppShell.tsx')
    expect(files.some(file => file.endsWith('.css'))).toBe(true)
    expect(files.every(file => !/\.test\./.test(file))).toBe(true)
  })

  it('没有渐变、毛玻璃与表情符号', () => {
    const bad = all.filter(item => item.rule !== 'hex')
    expect(bad.map(item => `${item.rule} ${item.file}:${item.line} ${item.text}`)).toEqual([])
  })

  it('令牌文件以外的十六进制色值不超过存量基线（新增文件、新增处数都失败）', () => {
    const over = [...hexByFile].filter(([file, count]) => count > (HEX_BASELINE[file] ?? 0)).map(([file, count]) => `${file}：${count} 处，基线 ${HEX_BASELINE[file] ?? 0}`)
    expect(over, '请改用 src/erp/theme/tokens.ts 的令牌或 Ant Design 的 CSS 变量，不要新增色值').toEqual([])
  })

  it('存量基线只减不增：文件里的色值减少后，要同步下调基线（保证棘轮不松）', () => {
    const slack = Object.entries(HEX_BASELINE)
      .filter(([file, count]) => (hexByFile.get(file) ?? 0) < count)
      .map(([file, count]) => `${file}：基线 ${count}，实际 ${hexByFile.get(file) ?? 0}`)
    expect(slack, '请把上面这些文件的基线下调到实际数字（为零的整行删掉）').toEqual([])
  })
})

describe('样式守卫：反向用例（故意违规必须失败）', () => {
  const rules = (path: string, source: string) => scanSource(path, source).map(item => item.rule)

  it('渐变：线性、径向、锥形都能抓到', () => {
    expect(rules('pages/x/A.tsx', "const s = { background: 'linear-gradient(90deg, red, blue)' }")).toEqual(['gradient'])
    expect(rules('pages/x/a.css', '.a { background: radial-gradient(circle, red, blue); }')).toEqual(['gradient'])
    expect(rules('pages/x/a.css', '.a { background: conic-gradient(red, blue); }')).toEqual(['gradient'])
  })
  it('毛玻璃：css 与对象写法都能抓到', () => {
    expect(rules('pages/x/a.css', '.a { backdrop-filter: blur(8px); }')).toEqual(['backdrop'])
    expect(rules('pages/x/A.tsx', "const s = { backdropFilter: 'blur(8px)' }")).toEqual(['backdrop'])
  })
  it('十六进制色值：令牌文件以外抓到（3、6、8 位），令牌文件放行', () => {
    expect(rules('pages/x/A.tsx', "const c = '#165dff'")).toEqual(['hex'])
    expect(rules('pages/x/A.tsx', "const c = '#fff'")).toEqual(['hex'])
    expect(rules('pages/x/A.tsx', "const c = '#165dffcc'")).toEqual(['hex'])
    expect(rules('pages/x/A.tsx', "const c = ['#165dff', '#ff7d00']")).toEqual(['hex', 'hex'])
    expect(rules('theme/tokens.ts', "const c = '#165dff'")).toEqual([])
    expect(rules('erp.css', ':root { --a: #165dff; }')).toEqual([])
  })
  it('十六进制色值：编号文字不误报（“订单 #123”、实体引用、颜色变量）', () => {
    expect(rules('pages/x/A.tsx', '<span>订单 #123</span>')).toEqual([])
    expect(rules('pages/x/A.tsx', '<span>&#8203;</span>')).toEqual([])
    expect(rules('pages/x/A.tsx', "const c = 'var(--ant-color-primary)'")).toEqual([])
    expect(rules('pages/x/A.tsx', '<span>第 #12 行</span>')).toEqual([])
  })
  it('表情符号：界面文案和字符串常量里都能抓到；线性图标字符与箭头不算', () => {
    expect(rules('pages/x/A.tsx', '<span>✨ 智能分析</span>')).toEqual(['emoji'])
    expect(rules('pages/x/A.tsx', "const label = '🔍 搜索'")).toEqual(['emoji'])
    expect(rules('pages/x/A.tsx', "const label = '📁 文件夹'")).toEqual(['emoji'])
    expect(rules('pages/x/A.tsx', "const label = '上涨 ↑ 下跌 ↓ 更多 →'")).toEqual([])
    expect(rules('pages/x/A.tsx', '<span>1,234.00</span>')).toEqual([])
  })
  it('哪些文件被扫描：界面代码扫，测试与夹具、非代码文件不扫', () => {
    expect(isScanned('shell/AppShell.tsx')).toBe(true)
    expect(isScanned('pages/x/a.css')).toBe(true)
    expect(isScanned('pages/x/A.test.tsx')).toBe(false)
    expect(isScanned('pages/x/fixtures.test-helper.ts')).toBe(false)
    expect(isScanned('test/style-guard.ts')).toBe(false)
    expect(isScanned('pages/x/data.json')).toBe(false)
  })
  it('违规记录带文件与行号，便于定位', () => {
    const found = scanSource('pages/x/A.tsx', "const a = 1\nconst b = 'linear-gradient(red, blue)'\n")
    expect(found).toEqual([{ rule: 'gradient', file: 'pages/x/A.tsx', line: 2, text: "const b = 'linear-gradient(red, blue)'" }])
  })
})
