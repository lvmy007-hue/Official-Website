// 从冻结清单 docs/erp-plan/freeze/routes.md 生成前端路由清单 src/erp/routes/manifest.generated.ts。
// 路由以文档为准：改清单后重新运行本脚本，由前端测试校验清单与文档一致（P1-03）。
//   node scripts/gen-route-manifest.mjs          生成
//   node scripts/gen-route-manifest.mjs --check  只校验，不一致则退出码为 1（持续集成使用）
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'docs/erp-plan/freeze/routes.md')
const target = join(root, 'src/erp/routes/manifest.generated.ts')

const lines = readFileSync(source, 'utf8').split(/\r?\n/)

// 个别路由第一个阶段标记是"过渡"而不是正式上线阶段，这里按文档说明显式指定
const FORMAL_STAGE = {
  '/app/overview': ['2a', 'P2a-02'],
  '/app/products/:id': ['2a', 'P2a-14'],
}

const cell = text => text.trim().replace(/`/g, '')

function parseAccess(raw) {
  const text = cell(raw)
  if (text === '基础') return { kind: 'base' }
  if (text.startsWith('公开')) return { kind: 'public' }
  if (text === '所有者、管理员') return { kind: 'owner-admin' }
  if (/^[a-z][a-z0-9.]*$/.test(text)) return { kind: 'permission', permission: text }
  throw new Error(`无法识别的权限列：${raw}`)
}

function parseStage(raw, path) {
  if (FORMAL_STAGE[path]) return { stage: FORMAL_STAGE[path][0], workPackage: FORMAL_STAGE[path][1] }
  const text = cell(raw).replace(/^阶段\s*/, '')
  const match = /^(1|2a|2b|3|4|5|6)(?:（(P[0-9ab]+-\d+)[^）]*）)?/.exec(text)
  if (!match) throw new Error(`无法识别的阶段列：${raw}（${path}）`)
  return { stage: match[1], workPackage: match[2] ?? '' }
}

const routes = []
const declared = new Map()
let group = ''
for (const line of lines) {
  const heading = /^### 2\.\d+ (.+?)（(\d+) 个路由）/.exec(line)
  if (heading) {
    group = heading[1]
    declared.set(group, Number(heading[2]))
  } else if (line.startsWith('## 六、补充路由')) group = '平台与公共'
  else if (line.startsWith('## ')) group = ''
  if (!group || !line.startsWith('| `/')) continue
  const cols = line.split('|').slice(1, -1)
  const path = cell(cols[0])
  const supplement = group === '平台与公共'
  if (cols.length !== (supplement ? 5 : 8)) throw new Error(`表格列数不对：${line}`)
  const stageRaw = supplement ? cols[4] : cols[7]
  routes.push({
    path,
    title: cell(cols[1]),
    group,
    component: cell(cols[2]),
    access: parseAccess(cols[3]),
    ...parseStage(stageRaw, path),
  })
}

// 小节标题里写的“N 个路由”必须与表格行数一致，防止挪动路由后标题没改
for (const [name, count] of declared) {
  const actual = routes.filter(item => item.group === name).length
  if (actual !== count) throw new Error(`小节“${name}”标题写 ${count} 个路由，表格里实际 ${actual} 个`)
}
// 107（3.5 表）+ 20（16 章【新】，阶段 6 未上线）+ 1（P6-11 外部货号映射，CR-119）+ 7（补充路由）
if (routes.length !== 138) throw new Error(`路由数量应为 138（107 + 23 + 1 + 7），实际 ${routes.length}`)
// 阶段 6 的路由必须有明确的工作包编号（P6-xx），否则无法知道谁来交付
const unowned = routes.filter(item => item.stage === '6' && !/^P6-\d+$/.test(item.workPackage)).map(item => item.path)
if (unowned.length > 0) throw new Error(`阶段 6 的路由缺少工作包编号：${unowned.join('、')}`)
const paths = new Set(routes.map(item => item.path))
if (paths.size !== routes.length) throw new Error('清单里有重复路由')
const components = new Set(routes.map(item => item.component))
if (components.size !== routes.length) throw new Error('清单里有重复组件名（每个路由必须一个独立组件）')

const body = routes.map(item => `  ${JSON.stringify(item)},`).join('\n')
const output = `// 本文件由 scripts/gen-route-manifest.mjs 从 docs/erp-plan/freeze/routes.md 生成，请勿手工修改。
import type { RouteSpec } from './types'

export const ROUTE_MANIFEST: readonly RouteSpec[] = [
${body}
]
`

const current = existsSync(target) ? readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : ''
if (process.argv.includes('--check')) {
  if (current !== output) {
    console.error('src/erp/routes/manifest.generated.ts 与 routes.md 不一致，请运行 node scripts/gen-route-manifest.mjs')
    process.exit(1)
  }
  console.log(`路由清单与 routes.md 一致（${routes.length} 个）`)
} else {
  writeFileSync(target, output)
  console.log(`已生成 ${target}（${routes.length} 个路由）`)
}
