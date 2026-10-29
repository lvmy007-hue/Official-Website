// 生产环境密钥配置体检（P5-13）：示例文件里的占位值与开发默认值是公开的，一旦原样带进生产，
// 任何看过仓库的人都能伪造登录令牌、解开已加密的授权数据。这里只判断“像不像示例或弱值”，不判断随机性强弱；
// 返回的问题清单由 API 与后台任务的启动流程汇总后拒绝启动。清单里只写变量名，不回显值。

type Env = Record<string, string | undefined>

const PLACEHOLDER = /replace|change[-_]?me|changeit|example|placeholder|dev[-_]password|_dev_|development|your[-_]|xxxx|todo/i
const MIN_DISTINCT_CHARS = 8

// 十六进制示例里常见的“顺序串”：0123456789abcdef 反复拼接
function isSequentialHex(value: string): boolean {
  const unit = '0123456789abcdef'
  return value.length >= 16 && value.toLowerCase() === unit.repeat(Math.ceil(value.length / unit.length)).slice(0, value.length)
}

export function looksLikePlaceholder(value: string): boolean {
  const text = value.trim()
  if (!text) return true
  if (PLACEHOLDER.test(text)) return true
  if (new Set(text.toLowerCase()).size < MIN_DISTINCT_CHARS) return true
  return isSequentialHex(text)
}

function urlPassword(value: string | undefined): string | null {
  if (!value) return null
  try {
    return decodeURIComponent(new URL(value).password)
  } catch {
    return null
  }
}

function masterKeyValues(env: Env): string[] {
  const values: string[] = []
  const token = env.TOKEN_ENCRYPTION_KEY?.trim()
  if (token) values.push(token)
  for (const item of (env.ENCRYPTION_MASTER_KEYS ?? '').split(',')) {
    const index = item.indexOf(':')
    if (index >= 0) values.push(item.slice(index + 1).trim())
  }
  return values.filter(Boolean)
}

export function secretConfigProblems(env: Env = process.env): string[] {
  const problems: string[] = []
  const check = (name: string, value: string | undefined, required: boolean) => {
    const text = value?.trim()
    if (!text) {
      if (required) problems.push(`${name} 未配置`)
      return
    }
    if (looksLikePlaceholder(text)) problems.push(`${name} 仍是示例值或过于简单，请换成随机生成的值`)
  }
  check('JWT_SECRET', env.JWT_SECRET, true)
  check('STORAGE_SIGNING_KEY', env.STORAGE_SIGNING_KEY, false)
  if (masterKeyValues(env).some(looksLikePlaceholder)) problems.push('TOKEN_ENCRYPTION_KEY 或 ENCRYPTION_MASTER_KEYS 里有示例主密钥或过于简单的值，请换成随机生成的 64 位十六进制')
  for (const name of ['DATABASE_URL', 'DATABASE_SYSTEM_URL', 'QUEUE_REDIS_URL', 'CACHE_REDIS_URL']) {
    const password = urlPassword(env[name])
    if (password !== null && password !== '' && looksLikePlaceholder(password)) problems.push(`${name} 里的密码仍是示例值或过于简单`)
  }
  return problems
}
