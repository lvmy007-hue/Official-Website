import { describe, expect, it } from 'vitest'
import { connectionUrlWithPool, databaseDeploymentProblems, databaseTransportProblems, statementTimeoutFromEnv } from './connection-config.js'

const base = 'postgresql://nova_app:pw@pgbouncer:6432/nova_erp?schema=public'

describe('连接串补连接池参数', () => {
  it('没配置时原样（规范化后）返回，不凭空加参数', () => {
    expect(connectionUrlWithPool(base, {})).toBe(base)
    expect(connectionUrlWithPool(undefined, { DB_POOL_SIZE: '10' })).toBeUndefined()
  })

  it('按环境变量补连接数上限、排队超时与 PgBouncer 标记', () => {
    const url = new URL(connectionUrlWithPool(base, { DB_POOL_SIZE: '12', DB_POOL_TIMEOUT_SECONDS: '8', DB_PGBOUNCER: 'true' })!)
    expect(url.searchParams.get('connection_limit')).toBe('12')
    expect(url.searchParams.get('pool_timeout')).toBe('8')
    expect(url.searchParams.get('pgbouncer')).toBe('true')
    expect(url.searchParams.get('schema')).toBe('public')
  })

  it('连接串里已经写明的参数优先；非法数字被忽略', () => {
    const url = new URL(connectionUrlWithPool(`${base}&connection_limit=3`, { DB_POOL_SIZE: '12', DB_POOL_TIMEOUT_SECONDS: 'abc' })!)
    expect(url.searchParams.get('connection_limit')).toBe('3')
    expect(url.searchParams.has('pool_timeout')).toBe(false)
  })
})

describe('语句超时', () => {
  it('写明则用，缺省或非法（含 0，不允许关闭）取默认值', () => {
    expect(statementTimeoutFromEnv('X', 30000, { X: '5000' })).toBe(5000)
    expect(statementTimeoutFromEnv('X', 30000, {})).toBe(30000)
    expect(statementTimeoutFromEnv('X', 30000, { X: '0' })).toBe(30000)
    expect(statementTimeoutFromEnv('X', 30000, { X: '-1' })).toBe(30000)
    expect(statementTimeoutFromEnv('X', 30000, { X: 'abc' })).toBe(30000)
  })
})

describe('生产数据库传输安全检查', () => {
  it('默认（单机内网）不强制加密，但永远拒绝关闭证书校验', () => {
    expect(databaseTransportProblems({ DATABASE_URL: base }, {})).toEqual([])
    const problems = databaseTransportProblems({ DATABASE_URL: `${base}&sslmode=require&sslaccept=accept_invalid_certs` }, {})
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('accept_invalid_certs')
  })

  it('DB_REQUIRE_TLS=true：每个连接串都必须启用加密', () => {
    const env = { DB_REQUIRE_TLS: 'true' }
    expect(databaseTransportProblems({ DATABASE_URL: base, DATABASE_SYSTEM_URL: `${base}&sslmode=verify-full` }, env)).toEqual([expect.stringContaining('DATABASE_URL')])
    expect(databaseTransportProblems({ DATABASE_URL: `${base}&sslmode=require`, DATABASE_SYSTEM_URL: `${base}&sslmode=prefer` }, env)).toEqual([expect.stringContaining('DATABASE_SYSTEM_URL')])
    expect(databaseTransportProblems({ DATABASE_URL: `${base}&sslmode=require`, DATABASE_SYSTEM_URL: undefined }, env)).toEqual([])
  })

  it('连接串格式错误给出明确提示', () => {
    expect(databaseTransportProblems({ DATABASE_URL: 'not a url' }, {})).toEqual([expect.stringContaining('格式不正确')])
  })
})

describe('生产数据库部署检查', () => {
  const ok = { DATABASE_URL: base, DATABASE_SYSTEM_URL: base.replace('nova_app', 'nova_system') }
  it('两个连接串都配置且传输安全：通过', () => {
    expect(databaseDeploymentProblems(ok)).toEqual([])
  })
  it('缺系统连接串（与租户连接共用账号）：拒绝；缺租户连接串：拒绝', () => {
    expect(databaseDeploymentProblems({ DATABASE_URL: base })).toEqual([expect.stringContaining('DATABASE_SYSTEM_URL')])
    expect(databaseDeploymentProblems({ DATABASE_SYSTEM_URL: ok.DATABASE_SYSTEM_URL })).toEqual([expect.stringContaining('DATABASE_URL')])
  })
  it('同时检查传输安全', () => {
    expect(databaseDeploymentProblems({ ...ok, DB_REQUIRE_TLS: 'true' })).toHaveLength(2)
  })
})
