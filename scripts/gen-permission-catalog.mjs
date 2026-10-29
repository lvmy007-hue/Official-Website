// 从冻结清单 docs/erp-plan/freeze/permissions.md 生成权限目录 packages/authz/src/catalog.ts。
// 权限点以文档为准：改清单后重新运行本脚本，并由 packages/authz 的测试校验两者一致。
//   node scripts/gen-permission-catalog.mjs          生成
//   node scripts/gen-permission-catalog.mjs --check  只校验，不一致则退出码为 1（持续集成使用）
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'docs/erp-plan/freeze/permissions.md')
const target = join(root, 'packages/authz/src/catalog.ts')

const ROLE_KEYS = ['owner', 'admin', 'ops', 'ads', 'finance', 'supply', 'readonly']
const text = readFileSync(source, 'utf8')
const lines = text.split(/\r?\n/)

// 只解析第二节“权限点全量清单”（2.1 ~ 2.10 的表格），旧权限与字段权限不在其中。
const start = lines.findIndex(line => line.startsWith('## 二、权限点全量清单'))
const end = lines.findIndex(line => line.startsWith('### 2.11'))
if (start < 0 || end < 0) throw new Error('权限清单结构变化：找不到第二节或 2.11')

const entries = []
let group = ''
for (const line of lines.slice(start, end)) {
  const heading = /^### 2\.\d+ (.+)$/.exec(line)
  if (heading) {
    group = heading[1]
    continue
  }
  const match = /^\| `([a-z][a-z0-9.]*)` \| (.+?) \| (查看|写入|审批|管理|导出) \| (.+) \|$/.exec(line)
  if (!match) continue
  const marks = match[4].split('|').map(item => item.trim())
  if (marks.length !== ROLE_KEYS.length) throw new Error(`权限点 ${match[1]} 的角色列数量不是 ${ROLE_KEYS.length}`)
  const roles = ROLE_KEYS.filter((_, index) => marks[index] === '✓')
  entries.push({ key: match[1], group, label: match[2], kind: match[3], roles })
}

if (new Set(entries.map(entry => entry.key)).size !== entries.length) throw new Error('权限清单中有重复的权限点')

const body = entries
  .map(
    entry =>
      `  { key: ${JSON.stringify(entry.key)}, group: ${JSON.stringify(entry.group)}, label: ${JSON.stringify(entry.label)}, kind: ${JSON.stringify(entry.kind)}, roles: ${JSON.stringify(entry.roles)} },`,
  )
  .join('\n')

const output = `// 本文件由 scripts/gen-permission-catalog.mjs 根据 docs/erp-plan/freeze/permissions.md 生成，请勿手工修改。
export type RoleKey = ${ROLE_KEYS.map(key => JSON.stringify(key)).join(' | ')}
export type PermissionKind = '查看' | '写入' | '审批' | '管理' | '导出'
export interface PermissionEntry {
  key: string
  group: string
  label: string
  kind: PermissionKind
  /** 预设角色里默认拥有该权限点的角色（所有者拥有全部，这里也列出）。 */
  roles: RoleKey[]
}

export const ROLE_KEYS: readonly RoleKey[] = ${JSON.stringify(ROLE_KEYS)}

export const PERMISSION_CATALOG: readonly PermissionEntry[] = [
${body}
]
`

if (process.argv.includes('--check')) {
  let current
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    current = ''
  }
  if (current.replace(/\r\n/g, '\n') !== output) {
    console.error('packages/authz/src/catalog.ts 与 permissions.md 不一致，请运行 node scripts/gen-permission-catalog.mjs')
    process.exit(1)
  }
  console.log(`权限目录与清单一致（${entries.length} 个权限点）`)
} else {
  writeFileSync(target, output, 'utf8')
  console.log(`已生成 ${target}，共 ${entries.length} 个权限点`)
}
