import { describe, expect, it } from 'vitest'
import { collectInitialChunks, evaluateBudget, type Manifest } from '../../../scripts/bundle-budget.mjs'

// 首屏体积预算的计算规则（P1-09，12.4）：只统计入口的静态依赖，动态引入的块不计入。
const manifest: Manifest = {
  'index.html': { file: 'assets/index.js', isEntry: true, dynamicImports: ['src/app-entry.tsx'] },
  '_app-entry-abc.js': { file: 'assets/app-entry-abc.js', imports: ['_react-1.js', 'index.html'], dynamicImports: ['src/erp/pages/LoginPage.tsx'] },
  '_react-1.js': { file: 'assets/react-1.js' },
  'src/erp/pages/LoginPage.tsx': { file: 'assets/LoginPage.js', imports: ['_app-entry-abc.js'] },
  'src/erp/pages/OverviewPage.tsx': { file: 'assets/OverviewPage.js', imports: ['_app-entry-abc.js', '_overview-lib.js'] },
  '_overview-lib.js': { file: 'assets/overview-lib.js' },
  'style.css': { file: 'assets/app-entry.css' },
}
const sizes: Record<string, number> = {
  'assets/index.js': 1000,
  'assets/app-entry-abc.js': 200_000,
  'assets/react-1.js': 40_000,
  'assets/LoginPage.js': 90_000,
  'assets/OverviewPage.js': 30_000,
  'assets/overview-lib.js': 10_000,
}
const read = (file: string) => sizes[file] ?? 0

describe('首屏体积预算', () => {
  it('统计入口、外壳与首页的静态依赖，不含登录页等动态块与样式文件', () => {
    const files = collectInitialChunks(manifest)
      .map(chunk => chunk.file)
      .sort()
    expect(files).toEqual(['assets/OverviewPage.js', 'assets/app-entry-abc.js', 'assets/index.js', 'assets/overview-lib.js', 'assets/react-1.js'])
  })

  it('合计不超过预算则通过', () => {
    const result = evaluateBudget(manifest, read, 300_000)
    expect(result.total).toBe(281_000)
    expect(result.ok).toBe(true)
    expect(result.chunks[0].file).toBe('assets/app-entry-abc.js')
  })

  it('超出预算则不通过', () => {
    expect(evaluateBudget(manifest, read, 250_000).ok).toBe(false)
  })

  it('没有首页块时只统计外壳', () => {
    const { 'src/erp/pages/OverviewPage.tsx': _drop, ...rest } = manifest
    void _drop
    expect(evaluateBudget(rest, read, 300_000).total).toBe(241_000)
  })
})
