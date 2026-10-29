import { Logger } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrismaService } from '../platform/prisma.service'
import { startTestDatabase, type TestDatabase } from './test-database'

// 真实连接：执行一条超过阈值的查询，确认会产生慢查询告警，快查询不会。
describe('慢查询告警（真实数据库）', () => {
  let db: TestDatabase
  let prisma: PrismaService
  const warnings: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('slow')
    process.env.DATABASE_URL = db.urlFor('slow')
    process.env.SLOW_QUERY_MS = '100'
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(message as Record<string, unknown>)
    })
    prisma = new PrismaService()
    await prisma.onModuleInit()
  })
  afterAll(async () => {
    await prisma?.onModuleDestroy()
    delete process.env.SLOW_QUERY_MS
    vi.restoreAllMocks()
    await db?.stop()
  })

  it('超过阈值的查询产生告警，且不包含参数', async () => {
    await prisma.$queryRaw`SELECT (pg_sleep(0.3))::text AS slept, ${'secret-param'}::text AS value`
    const slow = warnings.filter(w => w.event === 'slow_query')
    expect(slow.length).toBeGreaterThan(0)
    expect(slow[0].durationMs as number).toBeGreaterThanOrEqual(100)
    expect(JSON.stringify(slow)).not.toContain('secret-param')
  })

  it('快查询不告警', async () => {
    warnings.length = 0
    await prisma.$queryRaw`SELECT 1`
    expect(warnings.filter(w => w.event === 'slow_query')).toHaveLength(0)
  })
})
