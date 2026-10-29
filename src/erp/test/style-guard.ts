import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// 样式守卫（P6-01，15 章 2.3）：扫描 src/erp 下的 .ts、.tsx、.css，守住大厂风格的三条硬线。
// 规则与白名单都在这里，测试文件 style-guard.test.ts 负责断言与反向用例。

export type Violation = { rule: 'gradient' | 'backdrop' | 'hex' | 'emoji'; file: string; line: number; text: string }

const ERP_ROOT = join(__dirname, '..')

/** 渐变（骨架屏加载闪光除外）与毛玻璃。当前没有任何白名单文件；加白名单必须在 CR 里说明理由。 */
export const SKELETON_ALLOWED: readonly string[] = []

/** 令牌文件：允许写十六进制色值。theme/ 目录是令牌的唯一来源，erp.css 是与之核对的镜像。 */
export const TOKEN_FILES = (relativePath: string) => relativePath.startsWith('theme/') || relativePath === 'erp.css'

const GRADIENT = /(?:linear|radial|conic)-gradient\s*\(/i
const BACKDROP = /backdrop-?filter/i
// 6 位或 8 位十六进制；3 位的要含字母（或恰好是 #fff、#000），避免把“订单 #123”当成色值
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?=[0-9]*[a-fA-F])[0-9a-fA-F]{3}|fff|000)\b/g
const EMOJI = /\p{Extended_Pictographic}/u

/** 不属于“界面”的文件：测试、测试夹具、守卫自己。 */
export const isScanned = (relativePath: string) => /\.(ts|tsx|css)$/.test(relativePath) && !/\.test\.|\.test-helper\.|^test\//.test(relativePath)

export function scanSource(relativePath: string, source: string): Violation[] {
  const found: Violation[] = []
  const add = (rule: Violation['rule'], line: number, text: string) => found.push({ rule, file: relativePath, line, text: text.trim().slice(0, 100) })
  source.split('\n').forEach((text, index) => {
    const line = index + 1
    if (GRADIENT.test(text) && !SKELETON_ALLOWED.includes(relativePath)) add('gradient', line, text)
    if (BACKDROP.test(text)) add('backdrop', line, text)
    if (EMOJI.test(text)) add('emoji', line, text)
    if (!TOKEN_FILES(relativePath)) Array.from(text.matchAll(HEX)).forEach(() => add('hex', line, text))
  })
  return found
}

export function listSources(root: string = ERP_ROOT): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else {
        const rel = relative(root, full).replace(/\\/g, '/')
        if (isScanned(rel)) out.push(rel)
      }
    }
  }
  walk(root)
  return out.sort()
}

export function scanAll(root: string = ERP_ROOT): Violation[] {
  return listSources(root).flatMap(rel => scanSource(rel, readFileSync(join(root, rel), 'utf8')))
}
