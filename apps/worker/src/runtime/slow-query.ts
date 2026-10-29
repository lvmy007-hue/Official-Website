import type { Logger } from 'pino'
import type { Prisma, PrismaClient } from '@prisma/client'

/** 慢查询告警：超过 SLOW_QUERY_MS（默认 1000 毫秒）记录语句文本与耗时；不记录参数（可能含个人信息）。 */
export function registerSlowQueryLog(client: PrismaClient<Prisma.PrismaClientOptions, 'query'>, logger: Logger) {
  const thresholdMs = Number(process.env.SLOW_QUERY_MS) > 0 ? Number(process.env.SLOW_QUERY_MS) : 1000
  client.$on('query', event => {
    if (event.duration >= thresholdMs) logger.warn({ event: 'slow_query', durationMs: event.duration, thresholdMs, statement: event.query.replace(/\s+/g, ' ').trim().slice(0, 500) }, 'slow query')
  })
}
