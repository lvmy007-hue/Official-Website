// 个人信息守卫（P6-14）：接口响应、导出模板、日志调用里不许出现个人信息字段名；测试与持续集成共用这里的规则。
// 零 zod、零依赖。守卫只认“字段名”和“已知明文”两种信号：值的模式识别（邮箱、电话）会误伤成员邮箱、发货地址电话这类合法内容，不拿来整体拦截。

/** 个人信息字段名：出现在响应的键、导出的列、日志的字段里即视为泄露（统一转小写、去掉下划线与连字符后比较）。 */
export const PII_FORBIDDEN_KEYS = [
  'buyerName',
  'buyerEmail',
  'buyerPhone',
  'buyerAddress',
  'recipientName',
  'recipientEmail',
  'recipientPhone',
  'recipientAddress',
  'shipToName',
  'shipToPhone',
  'shipToAddress',
  'shippingAddress',
  'customerName',
  'customerEmail',
  'customerPhone',
  'customerAddress',
  'customerComments',
  'customerCommentsCipher',
  'piiCiphertext',
] as const

/** 日志脱敏要覆盖的键（api 与 worker 的 SENSITIVE_LOG_KEYS 必须包含它们，测试核对）。 */
export const PII_REDACT_KEYS: readonly string[] = [...PII_FORBIDDEN_KEYS, 'comment', 'comments', 'addressLine1', 'postalCode']

/** 守卫的唯一例外：只有查看明文的接口本身可以返回个人信息字段。 */
export const PII_GUARD_ALLOWED_PATHS: readonly string[] = ['/pii/reveal']
/** 源码扫描时允许出现个人信息字段名的目录（查看明文的模块）。 */
export const PII_GUARD_ALLOWED_SOURCE_DIRS: readonly string[] = ['modules/pii/']

const normalize = (key: string) => key.replace(/[_\-\s]/g, '').toLowerCase()
const FORBIDDEN = new Set(PII_FORBIDDEN_KEYS.map(normalize))

export const isPiiKey = (key: string): boolean => FORBIDDEN.has(normalize(key))

export interface PiiFinding {
  /** 出现的位置（键路径，或源码的行号）。 */
  where: string
  /** 命中的字段名或已知明文。 */
  what: string
}

/** 响应路径是否在例外清单里（只比较 /api/v1 之后的部分，忽略查询串）。 */
export function isGuardAllowedPath(path: string): boolean {
  const clean = (path.split('?')[0] ?? '').replace(/^\/api\/v1/, '').replace(/\/+$/, '')
  return PII_GUARD_ALLOWED_PATHS.includes(clean)
}

/** 递归检查一个响应体里的键名与已知明文（sentinels：测试里造数时放进去的明文，出现在任何位置都算泄露）。 */
export function scanResponse(body: unknown, sentinels: readonly string[] = [], options: { maxDepth?: number; maxItems?: number } = {}): PiiFinding[] {
  const found: PiiFinding[] = []
  const maxDepth = options.maxDepth ?? 14
  const maxItems = options.maxItems ?? 500
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > maxDepth) return
    if (typeof value === 'string') {
      for (const sentinel of sentinels) if (sentinel && value.includes(sentinel)) found.push({ where: path || '(根)', what: sentinel })
      return
    }
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const [index, item] of value.slice(0, maxItems).entries()) visit(item, `${path}[${index}]`, depth + 1)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (isPiiKey(key)) found.push({ where: path ? `${path}.${key}` : key, what: key })
      visit(child, path ? `${path}.${key}` : key, depth + 1)
    }
  }
  visit(body, '', 0)
  return found
}

const KEY_WORD = new RegExp(`\\b(?:${PII_FORBIDDEN_KEYS.join('|')})\\b|customer-comments`, 'i')

/** 找出源码里提到个人信息字段名的行（导出模板、取数代码）。行内注释与字符串都算：宁可多报，由白名单目录兜底。 */
export function scanSourceForPiiKeys(source: string): PiiFinding[] {
  const found: PiiFinding[] = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const hit = KEY_WORD.exec(line)
    if (hit) found.push({ where: `第 ${index + 1} 行`, what: hit[0] })
  }
  return found
}

const LOG_CALL = /\b(?:logger|log|ctx\.logger|deps\.logger|this\.logger|console)\s*\.\s*(?:trace|debug|info|warn|error|fatal|log)\s*\(/g
const LOG_NAME = new RegExp(`${KEY_WORD.source}|\\bcustomerComments\\b|\\bcomments?\\.text\\b`, 'i')

/** 找出日志调用的参数里出现个人信息字段名的位置。参数范围用括号配对取到调用结束（字符串里的括号忽略）。 */
export function scanLogCalls(source: string): PiiFinding[] {
  const found: PiiFinding[] = []
  for (const match of source.matchAll(LOG_CALL)) {
    const at = match.index ?? 0
    const args = readBalanced(source, at + match[0].length)
    const hit = LOG_NAME.exec(args)
    if (hit) found.push({ where: `第 ${source.slice(0, at).split('\n').length} 行`, what: hit[0] })
  }
  return found
}

/** 从 start（左括号之后）读到配对的右括号之前；不处理模板字符串里的嵌套，遇到 5000 字符还没配对就截断。 */
function readBalanced(source: string, start: number): string {
  let depth = 1
  let quote: string | null = null
  for (let i = start; i < Math.min(source.length, start + 5000); i++) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return source.slice(start, i)
  }
  return source.slice(start, Math.min(source.length, start + 5000))
}
