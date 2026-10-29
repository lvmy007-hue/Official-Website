#!/usr/bin/env node
// 安全静态检查（P5-13，12.9 第 13 条）：在持续集成里把关，防止有人把已经堵上的口子重新打开。
// 它只能发现“写法”层面的问题（危险接口、放开的来源、示例密钥），发现不了业务上的越权——越权由租户隔离检查、行级安全测试与全路由扫描测试负责。
// 规则：
//   S1  危险的渲染与执行接口：dangerouslySetInnerHTML、innerHTML 赋值、document.write、new Function、eval、child_process；
//   S2  关闭证书校验：rejectUnauthorized: false、NODE_TLS_REJECT_UNAUTHORIZED；
//   S3  window.open 只能走 security/safe-url.ts（带 noopener、只允许 http/https），白名单文件需写明理由；
//   S4  新窗口链接（target="_blank"）必须带 rel="noopener noreferrer"，且链接地址须经 safeHttpUrl 或是固定的 https 字面量；
//   S5  不得把令牌、密码、授权头写进浏览器存储（localStorage / sessionStorage）；
//   S6  原始 SQL 的语句文本不得拼接变量（只允许常量语句加位置参数）；Prisma.raw 禁用；
//   S7  Math.random 不得用于生成令牌与密钥（白名单里是抖动、实例编号、案件编号）；
//   S8  服务端主动发起的请求：下载与上传地址必须先过 assertRemoteUrl；固定目标的调用在此登记；
//   S9  跨域与 Cookie：不得放开任意来源；Cookie 只能在登录控制器里用 refreshCookie() 设置，且不得关闭 httpOnly；
//   S10 图表提示框里拼接 HTML 时必须经过 escapeHtml；
//   S11 仓库里不得出现私钥、云账号密钥、亚马逊令牌等形态的字符串；生产示例文件里的密钥类变量必须是 REPLACE_ 占位；
//   S12 网关配置不得开启目录列表或放开任意来源。
// 测试文件、测试工具目录与脚本目录不受 S1–S10 限制。新增合理用法时，必须在本文件登记并写明理由——登记本身就是评审点。
//
// 用法：node scripts/check-security.mjs            检查整个仓库
//       node scripts/check-security.mjs --self-test  用内置的违规样例验证规则确实会报错

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const normalize = path => path.split(sep).join('/')
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-ssr', '.git', 'coverage', '.turbo', 'test-results'])
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|mdc|yml|yaml|conf|sql|prisma|html|css|example|env|txt)$/
const SKIP_FILE = /(pnpm-lock\.yaml|\.tsbuildinfo|\.tmp\.txt|package-lock\.json)$/

export function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILE.test(name)) continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (TEXT_EXT.test(name) || name.startsWith('.env')) out.push(normalize(relative(root, full)))
  }
  return out
}

const CODE_EXT = /\.(ts|tsx|js|mjs)$/
const isTestish = path => /\.test\.|\.spec\.|\/testing\/|\/fixtures\/|\.d\.ts$|^scripts\/|\.config\.(ts|js|mjs)$/.test(path)
const inCode = path => CODE_EXT.test(path) && !isTestish(path) && /^(apps|packages|src|database)\//.test(path)

// 逐行规则：pattern 命中该行即违规；allow 是 [文件, 理由]
const lineRules = [
  {
    id: 'S1',
    title: '危险的渲染与执行接口（dangerouslySetInnerHTML / innerHTML 赋值 / document.write / new Function / eval / child_process）',
    scope: inCode,
    pattern: /dangerouslySetInnerHTML|\.(inner|outer)HTML\s*=|insertAdjacentHTML|document\.write\(|new\s+Function\(|(?<![.\w])eval\(|\.eval\(|\bchild_process\b/,
    allow: [
      ['packages/workflow/src/rate-limit.ts', 'Redis 客户端的 eval：执行固定的令牌桶脚本，参数全部走 KEYS/ARGV'],
      ['packages/workflow/src/fair.ts', 'Redis 客户端的 eval：执行固定的租约脚本，参数全部走 KEYS/ARGV'],
    ],
  },
  {
    id: 'S2',
    title: '不得关闭证书校验',
    scope: inCode,
    pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/,
    allow: [],
  },
  {
    id: 'S3',
    title: 'window.open 只能走 security/safe-url.ts',
    scope: path => inCode(path) && /^src\//.test(path),
    pattern: /window\.open\(/,
    allow: [
      ['src/erp/security/safe-url.ts', 'openSignedUrl 的实现本身：校验协议并带 noopener,noreferrer'],
      ['src/erp/platform/PlatformSupportAccessPage.tsx', '固定站内路径 /app/overview，需要新窗口继承会话存储才能带着支持访问身份打开，不带 noopener 是有意的'],
    ],
  },
  {
    id: 'S5',
    title: '不得把令牌、密码、授权头写进浏览器存储',
    scope: path => inCode(path) && /^src\//.test(path),
    pattern: /(local|session)Storage\.setItem\([^)]*(token|password|secret|authorization)/i,
    allow: [['src/erp/platform/PlatformSupportAccessPage.tsx', '支持访问令牌交给新窗口的一次性交接：只放会话存储，新窗口读取后立即删除，打开窗口的页面 1 秒后也会删除，不进入本地存储']],
  },
  {
    id: 'S7',
    title: 'Math.random 不得用于令牌与密钥（需要随机令牌请用 node:crypto）',
    scope: path => inCode(path) && /^(apps|packages)\//.test(path),
    pattern: /Math\.random\(/,
    allow: [
      ['packages/workflow/src/backoff.ts', '重试退避的抖动，不涉及安全'],
      ['apps/worker/src/runtime/reliability.ts', '后台任务实例编号，不涉及安全'],
      ['apps/worker/src/runtime/job-runner.ts', '任务调度抖动，不涉及安全'],
      ['apps/api/src/modules/reimbursements/reimbursements-common.ts', '案件编号的展示用随机码，不是密钥；冲突时重试，访问仍需登录与权限'],
    ],
  },
  {
    id: 'S9a',
    title: '不得放开任意跨域来源，也不得关闭 httpOnly',
    scope: inCode,
    pattern: /origin\s*:\s*(true|'\*'|"\*")|enableCors\(\s*\)|httpOnly\s*:\s*false/,
    allow: [],
  },
  {
    id: 'S9b',
    title: 'Cookie 只能在登录控制器里用 refreshCookie() 设置',
    scope: inCode,
    pattern: /\.cookie\(/,
    allow: [['apps/api/src/modules/auth/auth.controller.ts', '刷新令牌 Cookie：HttpOnly、SameSite=Strict、限定路径，参数由 refreshCookie() 统一给出']],
    also: line => !/refreshCookie\(\)/.test(line) || /^\s*\/\//.test(line),
    onlyIfAllowedFile: true,
  },
  {
    id: 'S12',
    title: '网关配置不得开启目录列表或放开任意来源',
    scope: path => /^infrastructure\/.*\.conf$/.test(path),
    pattern: /autoindex\s+on|Access-Control-Allow-Origin\s+["']?\*/,
    allow: [],
  },
]

// 服务端主动请求：这些行可以不经 assertRemoteUrl，因为目标是配置里的固定地址（授权服务、支付网关、亚马逊接口的固定入口）
const fetchAllow = [
  ['apps/api/src/modules/commerce/alipay.service.ts', /await fetch\(this\.gateway\(\)/, '支付宝网关：地址来自配置，不来自用户输入'],
  ['apps/api/src/modules/connections/ads-oauth.service.ts', /LWA_TOKEN_URL/, '广告授权换令牌：地址来自配置'],
  ['apps/api/src/modules/connections/sp-oauth.service.ts', /LWA_TOKEN_URL/, '卖家授权换令牌：地址来自配置'],
  ['apps/worker/src/connectors/amazon-sp-api.ts', /LWA_TOKEN_URL|await fetch\(url, \{ method: options\.method/, '亚马逊接口与授权服务：主机由区域配置决定，路径由代码拼接'],
  ['apps/worker/src/connectors/amazon-ads-api.ts', /LWA_TOKEN_URL|await fetch\(url, \{ method: options\.method/, '广告接口与授权服务：主机由区域配置决定，路径由代码拼接'],
  ['apps/worker/src/connectors/aplus-api.ts', /await fetch\(uploadUrl,/, '上传地址已在上一行经 assertRemoteUrl 校验'],
]

// 多行规则：对整份文件文本匹配
const textRules = [
  {
    id: 'S6',
    title: '原始 SQL 的语句文本不得拼接变量（只允许常量语句加位置参数）；Prisma.raw 禁用',
    scope: inCode,
    pattern: /\$(?:query|execute)RawUnsafe(?:<[^(]*>)?\(\s*(?:`[^`]*\$\{|(?:'[^'\n]*'|"[^"\n]*")\s*\+)|Prisma\.raw\b/,
    allow: [
      ['packages/tenancy/src/scoped-client.ts', '这里是拦截并检查原始调用的实现，不是调用方'],
      ['apps/worker/src/lifecycle/close-sql.ts', '表名来自数据库目录并逐个校验为安全标识符后加引号，每页行数先取整；租户编号与游标都走位置参数'],
    ],
  },
]

const SECRET_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, '私钥'],
  [/\bAKIA[0-9A-Z]{16}\b/, '云账号访问密钥'],
  [/\bLTAI[0-9A-Za-z]{12,}\b/, '阿里云访问密钥编号'],
  [/\bAtza\|[A-Za-z0-9_-]{20,}/, '亚马逊访问令牌'],
  [/\bAtzr\|[A-Za-z0-9_-]{20,}/, '亚马逊刷新令牌'],
  [/amzn1\.application-oa2-client\.[0-9a-f]{20,}/, '亚马逊应用客户端编号'],
  [/\bsk_live_[0-9a-zA-Z]{16,}/, '支付密钥'],
  [/\bghp_[A-Za-z0-9]{30,}/, '代码托管访问令牌'],
]
// 跳过：本脚本自己的样例、测试夹具、去敏测试里的虚构令牌样例
const SECRET_SCAN_SKIP = /^scripts\/check-security\.mjs$|\/fixtures\/|^packages\/workflow\/src\/dead-letter\.test\.ts$/

const STRING_LITERAL = /`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g
const HTML_TAG = /<(?:br|b|i|span|div|strong|em|p|a|li|ul)\b[^>]*>/
// 字符串字面量里带 HTML 标签，且是模板（含 ${）或与其他内容拼接：这类字符串会被图表提示框当成 HTML 渲染
function buildsHtml(line) {
  const literals = line.match(STRING_LITERAL) ?? []
  return literals.some(item => HTML_TAG.test(item) && (item.includes('${') || /\+/.test(line.replace(STRING_LITERAL, ''))))
}

export function checkFile(path, text) {
  const problems = []
  const lines = text.split(/\r?\n/)
  const fail = (rule, line, note) => problems.push(`${rule} ${path}:${line}  ${note}`)
  for (const rule of [...lineRules]) {
    if (!rule.scope(path)) continue
    const allowed = rule.allow.some(([file]) => file === path)
    lines.forEach((line, index) => {
      if (!rule.pattern.test(line)) return
      if (rule.onlyIfAllowedFile) {
        if (allowed && !rule.also(line)) return
        fail(rule.id, index + 1, `${rule.title}：${line.trim().slice(0, 120)}`)
        return
      }
      if (!allowed) fail(rule.id, index + 1, `${rule.title}：${line.trim().slice(0, 120)}`)
    })
  }
  for (const rule of textRules) {
    if (!rule.scope(path) || rule.allow.some(([file]) => file === path)) continue
    const match = rule.pattern.exec(text)
    if (match) fail(rule.id, text.slice(0, match.index).split('\n').length, `${rule.title}：${match[0].replace(/\s+/g, ' ').slice(0, 100)}`)
  }
  if (inCode(path) && /^src\/erp\//.test(path)) {
    lines.forEach((line, index) => {
      if (/target=("_blank"|\{'_blank'\})/.test(line)) {
        const near = lines.slice(Math.max(0, index - 3), index + 4).join('\n')
        if (!/rel=("|\{'|\{")[^"'}]*noopener/.test(near)) fail('S4', index + 1, '新窗口链接缺少 rel="noopener noreferrer"')
        if (!/safeHttpUrl\(|href="https:\/\//.test(near)) fail('S4', index + 1, '新窗口链接的地址须经 safeHttpUrl 或是固定的 https 字面量')
      }
      if (buildsHtml(line)) {
        const near = lines.slice(Math.max(0, index - 4), index + 5).join('\n')
        if (!/escapeHtml\(/.test(near)) fail('S10', index + 1, '图表提示框拼接 HTML 时必须经过 escapeHtml')
      }
    })
  }
  if (inCode(path) && /^apps\//.test(path)) {
    lines.forEach((line, index) => {
      if (!/\bawait\s+fetch\(|=\s*fetch\(/.test(line) || line.includes('assertRemoteUrl(')) return
      const ok = fetchAllow.some(([file, pattern]) => file === path && pattern.test(line))
      if (!ok) fail('S8', index + 1, `服务端请求的地址必须先过 assertRemoteUrl，或在本脚本登记固定目标：${line.trim().slice(0, 120)}`)
    })
  }
  if (!SECRET_SCAN_SKIP.test(path)) {
    for (const [pattern, name] of SECRET_PATTERNS) {
      lines.forEach((line, index) => {
        if (pattern.test(line)) fail('S11', index + 1, `疑似${name}`)
      })
    }
  }
  if (path === '.env.aliyun.example') {
    lines.forEach((line, index) => {
      const match = /^([A-Z0-9_]*(?:SECRET|PASSWORD|KEY)[A-Z0-9_]*)=(.+)$/.exec(line.trim())
      if (match && !/_URL$|_ID$|_ACTIVE$|_PROVIDER$/.test(match[1]) && !/^REPLACE_/.test(match[2])) {
        fail('S11', index + 1, `生产示例文件里的 ${match[1]} 必须是 REPLACE_ 开头的占位值`)
      }
    })
  }
  return problems
}

function run() {
  const problems = []
  for (const path of walk(root)) problems.push(...checkFile(path, readFileSync(join(root, path), 'utf8')))
  if (problems.length) {
    console.error('安全静态检查未通过：')
    for (const item of problems) console.error(`  ${item}`)
    console.error('\n合理的新用法请在 scripts/check-security.mjs 登记并写明理由。')
    process.exit(1)
  }
  console.log('安全静态检查通过')
}

// 内置的违规样例：每条规则至少有一个必须报错的写法和一个必须放行的写法
function selfTest() {
  const bad = [
    ['S1', 'src/erp/a.tsx', '<div dangerouslySetInnerHTML={{ __html: x }} />'],
    ['S1', 'apps/api/src/a.ts', 'const f = new Function("return 1")'],
    ['S2', 'apps/api/src/a.ts', 'const o = { rejectUnauthorized: false }'],
    ['S3', 'src/erp/pages/a.tsx', "window.open(url, '_blank')"],
    ['S4', 'src/erp/pages/a.tsx', '<a href={row.url} target="_blank">x</a>'],
    ['S5', 'src/erp/a.ts', "localStorage.setItem('accessToken', value)"],
    ['S6', 'apps/api/src/a.ts', 'await db.$queryRawUnsafe(`SELECT * FROM "T" WHERE id = ${id}`)'],
    ['S6', 'apps/api/src/a.ts', 'await db.$executeRawUnsafe("DELETE FROM T WHERE id = " + id)'],
    ['S6', 'apps/api/src/a.ts', 'Prisma.raw(name)'],
    ['S7', 'apps/api/src/a.ts', 'const token = Math.random().toString(36)'],
    ['S8', 'apps/worker/src/connectors/a.ts', 'const r = await fetch(url)'],
    ['S9a', 'apps/api/src/a.ts', 'app.enableCors({ origin: true, credentials: true })'],
    ['S9a', 'apps/api/src/a.ts', "res.cookie('a', b, { httpOnly: false })"],
    ['S9b', 'apps/api/src/b.ts', "res.cookie('x', y)"],
    ['S9b', 'apps/api/src/modules/auth/auth.controller.ts', "response.cookie('x', y, { path: '/' })"],
    ['S10', 'src/erp/pages/a-options.ts', 'formatter: (p) => `${p.name}<br/>${p.value}`'],
    ['S11', 'docs/a.md', '-----BEGIN RSA PRIVATE KEY-----'],
    ['S11', 'apps/api/src/a.ts', "const k = 'AKIAABCDEFGHIJKLMNOP'"],
    ['S11', '.env.aliyun.example', 'JWT_SECRET=0123abcd'],
    ['S12', 'infrastructure/aliyun/nginx.conf', '  autoindex on;'],
    ['S12', 'infrastructure/aliyun/nginx.conf', '  add_header Access-Control-Allow-Origin * always;'],
  ]
  const good = [
    ['src/erp/security/safe-url.ts', 'window.open(url, "_blank", "noopener,noreferrer")'],
    ['apps/api/src/a.ts', 'await db.$queryRawUnsafe("SELECT 1 WHERE id = $1", id)'],
    ['apps/api/src/a.ts', 'await db.$queryRaw`SELECT 1 WHERE id = ${id}`'],
    ['apps/api/src/a.test.ts', 'const f = new Function("return 1")'],
    ['apps/worker/src/connectors/a.ts', 'const r = await fetch(assertRemoteUrl(url, "x"))'],
    ['apps/api/src/modules/auth/auth.controller.ts', 'response.cookie(NAME, token, { ...refreshCookie(), maxAge: 1 })'],
    ['src/erp/pages/a.tsx', '<a href={safeHttpUrl(row.url) ?? undefined} target="_blank" rel="noopener noreferrer">x</a>'],
    ['src/erp/pages/a.tsx', '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">x</a>'],
    ['src/erp/pages/a-options.ts', 'formatter: (p) => `${escapeHtml(p.name)}<br/>${p.value}`'],
    ['apps/api/src/a.ts', "const code = 'ABCDEF'"],
    ['.env.aliyun.example', 'JWT_SECRET=REPLACE_RANDOM_SECRET'],
    ['.env.aliyun.example', 'AMAZON_SP_LWA_TOKEN_URL=https://api.amazon.com/auth/o2/token'],
  ]
  let failures = 0
  for (const [rule, path, text] of bad) {
    // 允许一行样例里额外触发其他规则，只要求目标规则报错
    const hit = checkFile(path, text).some(item => item.startsWith(`${rule} `))
    if (!hit) {
      failures += 1
      console.error(`自检失败：规则 ${rule} 没有发现违规写法：${text}`)
    }
  }
  for (const [path, text] of good) {
    const found = checkFile(path, text)
    if (found.length) {
      failures += 1
      console.error(`自检失败：合规写法被误报：${text}\n  ${found.join('\n  ')}`)
    }
  }
  if (failures) process.exit(1)
  console.log(`安全静态检查自检通过（${bad.length} 个违规样例都被发现，${good.length} 个合规样例都被放行）`)
}

if (process.argv[1] && normalize(process.argv[1]).endsWith('scripts/check-security.mjs')) {
  if (process.argv.includes('--self-test')) selfTest()
  else run()
}
