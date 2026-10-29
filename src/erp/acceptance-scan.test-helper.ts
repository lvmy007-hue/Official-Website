import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// 全站验收（P5-14）用的源码扫描工具：只读文件，不执行页面代码。供 acceptance.test.ts 使用。

export const ROOT = resolve(__dirname, '..', '..')
export const ERP = join(ROOT, 'src', 'erp')

export const rel = (file: string) => relative(ROOT, file).replace(/\\/g, '/')

export function walk(path: string, out: string[] = []): string[] {
  if (statSync(path).isFile()) {
    out.push(path)
    return out
  }
  for (const name of readdirSync(path)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue
    walk(join(path, name), out)
  }
  return out
}

export const isTestFile = (file: string) => /\.test\.(ts|tsx)$/.test(file) || /\.test-helper\.(ts|tsx)$/.test(file) || /[\\/]test[\\/]/.test(file)

/** 生产代码（非测试、非测试替身）。 */
export const productionFiles = (dir: string) => walk(dir).filter(file => /\.(ts|tsx)$/.test(file) && !isTestFile(file) && !file.endsWith('.d.ts'))

const read = (file: string) => readFileSync(file, 'utf8')

/** 已登记页面：组件名 → 页面模块文件。 */
export function livePageFiles(): Map<string, string> {
  const text = read(join(ERP, 'routes', 'live-pages.ts'))
  const out = new Map<string, string>()
  for (const hit of text.matchAll(/^\s*(\w+):\s*\{\s*load:\s*\(\)\s*=>\s*import\('([^']+)'\)/gm)) {
    const base = resolve(ERP, 'routes', hit[2])
    const file = ['.tsx', '.ts', '/index.tsx', '/index.ts'].map(ext => base + ext).find(candidate => existsSync(candidate))
    if (file) out.set(hit[1], file)
  }
  return out
}

/** 路由清单里的全部组件名。 */
export function manifestComponents(): string[] {
  return [...read(join(ERP, 'routes', 'manifest.generated.ts')).matchAll(/"component":"(\w+)"/g)].map(hit => hit[1])
}

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  return ['.tsx', '.ts', '/index.tsx', '/index.ts'].map(ext => base + ext).find(candidate => existsSync(candidate)) ?? null
}

/** 页面入口文件经相对引用能到达的全部源码文件（含共享组件，不含测试）。 */
export function importClosure(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const text = read(file)
    for (const hit of text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      const next = resolveImport(file, hit[1])
      if (next && !isTestFile(next)) queue.push(next)
    }
  }
  return [...seen]
}

/** 去掉注释行后的文本，避免说明文字里的关键词造成误判。 */
export const codeOnly = (text: string) =>
  text
    .split(/\r?\n/)
    .filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')

export const sourceText = (file: string) => codeOnly(read(file))
