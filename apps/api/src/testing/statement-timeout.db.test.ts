import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isStatementTimeout } from '../platform/http'
import { startTestDatabase, type TestDatabase } from './test-database'

// P1-25 语句超时（真实数据库）：带租户的访问在事务里设置 statement_timeout，超时的语句被数据库取消，
// 错误能被识别为“查询过慢”；设置只在该事务内有效，不会泄漏到连接池里下一个使用者。
describe('语句超时（真实数据库）', () => {
  let db: TestDatabase
  let base: PrismaClient
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('timeout_main')
    db.migrate('timeout_main')
    base = new PrismaClient({ datasources: { db: { url: `${db.urlFor('timeout_main', 'app')}?schema=public&connection_limit=1` } } })
  })
  afterAll(async () => {
    await base?.$disconnect()
    await db?.stop()
  })

  const scoped = (statementTimeoutMs?: number) => createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel), ...(statementTimeoutMs ? { statementTimeoutMs } : {}) })

  it('超过设定时间的语句被数据库取消，接口层把它识别为查询超时', async () => {
    const client = scoped(300)
    const started = Date.now()
    const error = await runWithTenant('tenant-a', () => client.$queryRaw`SELECT pg_sleep(5)`).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeDefined()
    expect(isStatementTimeout(error)).toBe(true)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('超时设置只在这个事务里有效：同一条连接上之后的访问不受影响', async () => {
    // connection_limit=1：下面两次访问必然复用同一条数据库连接
    const withTimeout = scoped(300)
    await runWithTenant('tenant-a', () => withTimeout.$queryRaw`SELECT 1`)
    const rows = await base.$queryRaw<Array<{ value: string }>>`SELECT current_setting('statement_timeout') AS value`
    expect(rows[0].value).toBe('0')
  })

  it('没有配置超时时不设置，沿用账号默认', async () => {
    const client = scoped()
    const rows = await runWithTenant('tenant-a', () => client.$queryRaw<Array<{ value: string }>>`SELECT current_setting('statement_timeout') AS value`)
    expect(rows[0].value).toBe('0')
  })
})
