// 数据库连接配置（P1-25，12 章 12.4 后端第 6 条、12.9 第 2 条）：
//   连接池大小与排队超时、经连接池中间件（PgBouncer）访问、语句超时、加密连接的生产检查。
// 都是纯函数，接口服务与后台任务共用，便于单元测试。

type Env = Record<string, string | undefined>

const positiveInt = (value: string | undefined): number | undefined => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * 在连接串上补连接池参数（连接串里已写明的参数优先，不覆盖）：
 *   DB_POOL_SIZE → connection_limit（单进程连接数上限）；DB_POOL_TIMEOUT_SECONDS → pool_timeout（排队等连接的最长时间）；
 *   DB_PGBOUNCER=true → pgbouncer=true（经 PgBouncer 事务池访问时必须开启：关闭预备语句缓存）。
 * 没有连接串（测试、未配置）时原样返回 undefined。
 */
export function connectionUrlWithPool(url: string | undefined, env: Env = process.env): string | undefined {
  if (!url) return undefined
  const parsed = new URL(url)
  const set = (name: string, value: string | undefined) => {
    if (value !== undefined && !parsed.searchParams.has(name)) parsed.searchParams.set(name, value)
  }
  set('connection_limit', positiveInt(env.DB_POOL_SIZE)?.toString())
  set('pool_timeout', positiveInt(env.DB_POOL_TIMEOUT_SECONDS)?.toString())
  if (env.DB_PGBOUNCER === 'true') set('pgbouncer', 'true')
  return parsed.toString()
}

/** 语句超时（毫秒）：环境变量写明则用，否则取默认值；0 或非法表示使用默认值（不允许“关闭超时”）。 */
export function statementTimeoutFromEnv(name: string, fallbackMs: number, env: Env = process.env): number {
  return positiveInt(env[name]) ?? fallbackMs
}

const SECURE_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full'])

/**
 * 生产环境数据库部署检查（接口服务与后台任务启动时调用）：两个连接串都必须配置（系统连接不得与租户连接共用同一账号），并通过传输安全检查。
 * 读取环境变量集中在这里，业务代码不直接接触系统连接串。
 */
export function databaseDeploymentProblems(env: Env = process.env): string[] {
  const problems: string[] = []
  if (!env.DATABASE_URL) problems.push('必须配置 DATABASE_URL（租户连接账号 nova_app）')
  if (!env.DATABASE_SYSTEM_URL) problems.push('必须配置 DATABASE_SYSTEM_URL（系统连接账号 nova_system），不得与租户连接共用同一账号')
  return [...problems, ...databaseTransportProblems({ DATABASE_URL: env.DATABASE_URL, DATABASE_SYSTEM_URL: env.DATABASE_SYSTEM_URL }, env)]
}

/**
 * 生产环境数据库连接的传输安全检查（返回问题列表，空数组表示通过）：
 *   - 任何情况下不允许关闭证书校验（sslaccept=accept_invalid_certs）；
 *   - DB_REQUIRE_TLS=true（跨机部署、托管数据库）时，连接串必须启用加密（sslmode=require / verify-ca / verify-full）。
 * 单机部署数据库与服务在同一私有网络内，默认不强制加密，跨机时必须打开。
 */
export function databaseTransportProblems(urls: Record<string, string | undefined>, env: Env = process.env): string[] {
  const problems: string[] = []
  const requireTls = env.DB_REQUIRE_TLS === 'true'
  for (const [name, url] of Object.entries(urls)) {
    if (!url) continue
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      problems.push(`${name}：连接串格式不正确`)
      continue
    }
    if (parsed.searchParams.get('sslaccept') === 'accept_invalid_certs') problems.push(`${name}：不允许 sslaccept=accept_invalid_certs（任何情况下都不得关闭证书校验）`)
    if (requireTls && !SECURE_SSL_MODES.has(parsed.searchParams.get('sslmode') ?? '')) problems.push(`${name}：DB_REQUIRE_TLS=true 时必须在连接串里写 sslmode=require（或 verify-ca / verify-full）`)
  }
  return problems
}
