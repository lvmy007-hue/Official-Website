// 代码规模检查（P1-09，12 章 12.6）：单文件不超过 400 行，禁止超长单行（超过 240 个字符）。
// 范围：新 ERP 前端（src/erp）、后端与共享包源码、脚本。官网源码与旧过渡页面不在范围内。
// 测试文件与自动生成的文件豁免“行数”要求（测试按场景罗列，拆分反而难读），但仍禁止超长单行。
// 历史遗留的超限文件登记在 LEGACY_LIMITS：登记的是“当前行数上限”，只允许变小不允许变大，新增超限文件一律失败。
//
// 用法：node scripts/check-code-quality.mjs [--self-test]

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAX_LINES = 400
export const MAX_LINE_LENGTH = 240

/** 遗留超限文件：路径 → 当前允许的最大行数。拆分后请把上限调小或删除条目。 */
export const LEGACY_LIMITS = {
  // 官网支付与订单服务，属官网后端，随官网后续改造时拆分（登记于 P1-09 汇报）
  'apps/api/src/modules/commerce/commerce.service.ts': 453,
}

const SCAN_ROOTS = ['src/erp', 'apps', 'packages', 'scripts']
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.cjs']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-ssr', 'coverage', '.turbo', 'generated'])
const isTest = path => /\.test\.(ts|tsx)$/.test(path) || path.includes(`${sep}testing${sep}`) || path.includes(`${sep}test${sep}`)

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) yield* walk(full)
    // 自动生成的文件（*.generated.ts）由生成脚本保证与来源一致，不按行数检查
    else if (EXTENSIONS.some(ext => name.endsWith(ext)) && !/\.d\.m?ts$/.test(name) && !name.includes('.generated.')) yield full
  }
}

/** 检查一组文件内容，返回问题列表。files: [{ path, text }]，path 用正斜杠的相对路径。 */
export function inspect(files, legacy = LEGACY_LIMITS) {
  const problems = []
  for (const { path, text } of files) {
    const lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const long = lines.map((line, index) => ({ line: line.replace(/\r$/, ''), number: index + 1 })).filter(item => item.line.length > MAX_LINE_LENGTH)
    for (const item of long.slice(0, 3)) problems.push(`${path}:${item.number} 单行 ${item.line.length} 个字符，超过 ${MAX_LINE_LENGTH}`)
    if (long.length > 3) problems.push(`${path} 另有 ${long.length - 3} 处超长单行`)
    if (isTest(path.split('/').join(sep))) continue
    const allowed = legacy[path] ?? MAX_LINES
    if (lines.length > allowed) problems.push(`${path} 共 ${lines.length} 行，超过上限 ${allowed}${legacy[path] ? '（遗留文件只允许缩小）' : ''}`)
  }
  return problems
}

function selfTest() {
  const big = Array.from({ length: 401 }, () => 'const a = 1').join('\n')
  const cases = [
    [[{ path: 'src/erp/a.ts', text: 'const a = 1\n' }], 0],
    [[{ path: 'src/erp/a.ts', text: big }], 1],
    [[{ path: 'src/erp/a.test.ts', text: big }], 0],
    [[{ path: 'src/erp/a.ts', text: `const a = '${'x'.repeat(250)}'\n` }], 1],
    [[{ path: 'src/erp/a.test.ts', text: `const a = '${'x'.repeat(250)}'\n` }], 1],
    [[{ path: 'src/erp/legacy.ts', text: big }], 0, { 'src/erp/legacy.ts': 401 }],
    [[{ path: 'src/erp/legacy.ts', text: big + '\nconst b = 2' }], 1, { 'src/erp/legacy.ts': 401 }],
  ]
  let failed = 0
  cases.forEach(([files, expected, legacy], index) => {
    const got = inspect(files, legacy ?? {}).length
    if (got !== expected) {
      failed += 1
      console.error(`自检失败：第 ${index + 1} 例期望 ${expected} 个问题，实际 ${got}`)
    }
  })
  if (failed > 0) process.exit(1)
  console.log('代码规模检查自检通过。')
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  const root = fileURLToPath(new URL('..', import.meta.url))
  const files = []
  for (const scan of SCAN_ROOTS) {
    try {
      for (const full of walk(join(root, scan))) files.push({ path: relative(root, full).split(sep).join('/'), text: readFileSync(full, 'utf8') })
    } catch {
      /* 目录不存在则跳过 */
    }
  }
  const problems = inspect(files)
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    console.error(`\n代码规模检查未通过：共 ${problems.length} 项。单文件不超过 ${MAX_LINES} 行，单行不超过 ${MAX_LINE_LENGTH} 个字符。`)
    process.exit(1)
  }
  console.log(`代码规模检查通过（共检查 ${files.length} 个文件）。`)
}

import { pathToFileURL } from 'node:url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
