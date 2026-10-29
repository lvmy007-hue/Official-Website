import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { redisClientOptions, redisProductionProblems, redisUrls } from './redis-config'

describe('Redis 地址解析', () => {
  it('队列与缓存可分开配置，缺省都退回 REDIS_URL', () => {
    expect(redisUrls({ REDIS_URL: 'redis://a:6379' })).toEqual({ queue: 'redis://a:6379', cache: 'redis://a:6379', separated: false })
    expect(redisUrls({ QUEUE_REDIS_URL: 'redis://q', CACHE_REDIS_URL: 'redis://c', REDIS_URL: 'redis://a' })).toEqual({ queue: 'redis://q', cache: 'redis://c', separated: true })
    expect(redisUrls({}).queue).toBe('redis://localhost:6379')
  })
})

describe('Redis 客户端选项', () => {
  it('明文连接：只有 BullMQ 要求的 maxRetriesPerRequest=null', () => {
    expect(redisClientOptions('redis://:pw@queue:6379', {})).toEqual({ maxRetriesPerRequest: null })
  })

  it('rediss://：启用 TLS，始终校验证书，最低 TLS 1.2', () => {
    const options = redisClientOptions('rediss://:pw@queue:6380', {})
    expect(options.tls).toEqual({ minVersion: 'TLSv1.2', rejectUnauthorized: true })
  })

  it('可选私有 CA 与服务器名；没有任何关闭证书校验的开关', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redis-ca-'))
    const caFile = join(dir, 'ca.pem')
    writeFileSync(caFile, 'FAKE-CA')
    const options = redisClientOptions('rediss://:pw@queue:6380', { REDIS_TLS_CA_FILE: caFile, REDIS_TLS_SERVERNAME: 'redis.internal', REDIS_TLS_REJECT_UNAUTHORIZED: 'false' })
    expect(options.tls?.ca?.toString()).toBe('FAKE-CA')
    expect(options.tls?.servername).toBe('redis.internal')
    expect(options.tls?.rejectUnauthorized).toBe(true)
  })
})

describe('生产 Redis 配置检查', () => {
  const good = { QUEUE_REDIS_URL: 'redis://:pw1@queue-redis:6379', CACHE_REDIS_URL: 'redis://:pw2@cache-redis:6379' }

  it('队列与缓存分开且都带密码：通过', () => {
    expect(redisProductionProblems(good)).toEqual([])
  })

  it('只配了 REDIS_URL（或缺一个）：拒绝', () => {
    expect(redisProductionProblems({ REDIS_URL: 'redis://:pw@r:6379' })).toEqual([expect.stringContaining('必须分别配置')])
    expect(redisProductionProblems({ QUEUE_REDIS_URL: good.QUEUE_REDIS_URL })).toHaveLength(1)
  })

  it('队列与缓存指向同一实例：拒绝（淘汰策略冲突）', () => {
    expect(redisProductionProblems({ QUEUE_REDIS_URL: good.QUEUE_REDIS_URL, CACHE_REDIS_URL: good.QUEUE_REDIS_URL })).toEqual([expect.stringContaining('同一个实例')])
  })

  it('不带密码：逐个指出', () => {
    const problems = redisProductionProblems({ QUEUE_REDIS_URL: 'redis://queue-redis:6379', CACHE_REDIS_URL: 'redis://cache-redis:6379' })
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('QUEUE_REDIS_URL')
    expect(problems[1]).toContain('CACHE_REDIS_URL')
  })

  it('REDIS_REQUIRE_TLS=true：必须 rediss://', () => {
    expect(redisProductionProblems({ ...good, REDIS_REQUIRE_TLS: 'true' })).toHaveLength(2)
    expect(redisProductionProblems({ QUEUE_REDIS_URL: 'rediss://:a@q:6380', CACHE_REDIS_URL: 'rediss://:b@c:6380', REDIS_REQUIRE_TLS: 'true' })).toEqual([])
  })

  it('REDIS_REQUIRE_TLS=true 且指定的 CA 文件读不到：拒绝', () => {
    const problems = redisProductionProblems({ QUEUE_REDIS_URL: 'rediss://:a@q:6380', CACHE_REDIS_URL: 'rediss://:b@c:6380', REDIS_REQUIRE_TLS: 'true', REDIS_TLS_CA_FILE: '/不存在/ca.pem' })
    expect(problems).toEqual([expect.stringContaining('REDIS_TLS_CA_FILE')])
  })
})
