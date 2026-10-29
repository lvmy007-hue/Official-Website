import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { METRIC_DEFINITIONS } from '@nova/api-contracts'

// 列头问号的代码检查（P6-03，14 章验收）：问号只读指标字典，页面里不能自己写口径文案。
// - 页面只写指标字典键（metric: 'M-206'），不用 headerTooltip / headerComponent 自己画列头说明；
// - 页面里用到的每个指标键都必须在字典里存在，否则问号会指向一个不存在的口径。

const ERP = resolve(__dirname)

function walk(path: string, out: string[] = []): string[] {
  if (statSync(path).isFile()) {
    out.push(path)
    return out
  }
  for (const name of readdirSync(path)) walk(join(path, name), out)
  return out
}

const sources = walk(ERP).filter(file => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file) && !file.includes('test-helper'))
const pages = sources.filter(file => file.includes(join('erp', 'pages')))
const code = (file: string) =>
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')

describe('列头问号只读指标字典', () => {
  it('页面不自己写列头说明：不用 headerTooltip 与 headerComponent', () => {
    const hits = pages.filter(file => /\bheaderTooltip\b|\bheaderComponent(Params)?\b/.test(code(file))).map(file => relative(ERP, file))
    expect(hits).toEqual([])
  })

  it('页面里用到的每个指标键都在指标字典里', () => {
    const known = new Set(METRIC_DEFINITIONS.map(item => item.id))
    const used: Array<{ file: string; id: string }> = []
    for (const file of sources) {
      for (const match of code(file).matchAll(/\bmetric:\s*'(M-[A-Za-z0-9-]+)'/g)) used.push({ file: relative(ERP, file), id: match[1]! })
    }
    expect(used.length).toBeGreaterThan(0)
    expect(used.filter(item => !known.has(item.id))).toEqual([])
  })

  it('字典里每条口径都带三个字段：对账页面、可能对不上的原因、在哪里配置', () => {
    for (const item of METRIC_DEFINITIONS) {
      expect(Array.isArray(item.reconcileWith)).toBe(true)
      expect(Array.isArray(item.mismatchReasons)).toBe(true)
      expect(item.configurableAt === null || typeof item.configurableAt.route === 'string').toBe(true)
    }
  })
})
