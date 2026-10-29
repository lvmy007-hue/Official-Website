// 前端首屏体积预算（P1-09，12 章 12.4）：外壳加首页脚本压缩后不超过 350KB，超出则构建失败。
//
// 口径：从构建清单里取 ERP 入口（index.html 的启动脚本、app-entry）以及首页页面（OverviewPage，上线后自动计入），
// 沿“静态引入”关系收集所有脚本，累加 gzip 后的字节数。动态引入（登录页、命令面板、日期选择器、图表、各业务页）不计入，
// 它们在需要时才加载。
//
// 用法：node scripts/bundle-budget.mjs [--limit-kb=350] [--dist=dist]

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEFAULT_LIMIT_BYTES = 350 * 1024

/** 起点：构建清单里这些键对应的块及其静态依赖。 */
// 同时匹配清单键和输出文件名（app-entry 被构建为共享块，键是 _app-entry-xxxx.js）。
export const ROOT_MATCHERS = [/^index\.html$/, /(^|\/)_?app-entry-[\w-]+\.js$/, /erp\/pages\/OverviewPage/]

/** 收集起点的静态依赖闭包（只含脚本文件）。 */
export function collectInitialChunks(manifest, roots = ROOT_MATCHERS) {
  const seen = new Set()
  const stack = Object.keys(manifest).filter(key => roots.some(pattern => pattern.test(key) || pattern.test(manifest[key].file ?? '')))
  while (stack.length) {
    const key = stack.pop()
    if (seen.has(key) || !manifest[key]) continue
    seen.add(key)
    for (const dep of manifest[key].imports ?? []) stack.push(dep)
  }
  return [...seen].map(key => ({ key, file: manifest[key].file })).filter(chunk => chunk.file.endsWith('.js'))
}

/** 计算体积并和预算比较。readGzipSize(file) 返回该文件 gzip 后的字节数。 */
export function evaluateBudget(manifest, readGzipSize, limitBytes = DEFAULT_LIMIT_BYTES, roots = ROOT_MATCHERS) {
  const chunks = collectInitialChunks(manifest, roots).map(chunk => ({ ...chunk, gzip: readGzipSize(chunk.file) }))
  const total = chunks.reduce((sum, chunk) => sum + chunk.gzip, 0)
  return { total, limitBytes, ok: total <= limitBytes, chunks: chunks.sort((a, b) => b.gzip - a.gzip) }
}

function main() {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .filter(arg => arg.startsWith('--'))
      .map(arg => arg.slice(2).split('=')),
  )
  const dist = resolve(args.dist ?? 'dist')
  const limit = args['limit-kb'] ? Number(args['limit-kb']) * 1024 : DEFAULT_LIMIT_BYTES
  const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8'))
  const result = evaluateBudget(manifest, file => gzipSync(readFileSync(join(dist, file))).length, limit)
  const kb = bytes => (bytes / 1024).toFixed(1) + ' KB'
  console.log('首屏脚本体积（gzip）：')
  for (const chunk of result.chunks) console.log(`  ${kb(chunk.gzip).padStart(10)}  ${chunk.file}`)
  console.log(`  ${kb(result.total).padStart(10)}  合计（预算 ${kb(result.limitBytes)}）`)
  if (!result.ok) {
    console.error(`首屏脚本超出预算 ${kb(result.total - result.limitBytes)}：请把非首屏必需的组件改为按需加载，或移除不必要的依赖。`)
    process.exit(1)
  }
  console.log('首屏体积预算检查通过。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
void fileURLToPath
