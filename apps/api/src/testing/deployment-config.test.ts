import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// P1-25 部署配置守护：部署文件是文本，没有真实容器环境时也能把“结构性约定”钉住，避免以后改动悄悄退化。
// 真实启动验证见 CR-017 的验收记录；这里只检查不依赖容器就能确认的约定。
const root = join(__dirname, '../../../..')
const read = (file: string) => readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n')

/** 取出某个顶层服务的文本块（从 "  名字:" 到下一个同级服务或顶层键之前）。 */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split('\n')
  const start = lines.findIndex(line => line === `  ${name}:`)
  if (start < 0) throw new Error(`没有找到服务 ${name}`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[index]) || /^[A-Za-z]/.test(lines[index])) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const composeFiles = { 开发: 'infrastructure/compose/docker-compose.yml', 阿里云: 'infrastructure/compose/docker-compose.aliyun.yml' } as const

describe.each(Object.entries(composeFiles))('%s环境的 compose', (_label, file) => {
  const compose = read(file)

  it('只有网关（web）对外映射端口；数据库、Redis、连接池、接口服务都不映射', () => {
    const withPorts = compose.split('\n').filter(line => /^\s+ports:/.test(line))
    expect(withPorts).toHaveLength(1)
    expect(serviceBlock(compose, 'web')).toContain('ports:')
    for (const name of ['postgres', 'queue-redis', 'cache-redis', 'pgbouncer', 'api', 'worker']) expect(serviceBlock(compose, name)).not.toContain('ports:')
  })

  it('队列与缓存是两个带密码的 Redis：队列不淘汰且持久化，缓存淘汰最久未用且不持久化', () => {
    const queue = serviceBlock(compose, 'queue-redis')
    const cache = serviceBlock(compose, 'cache-redis')
    for (const block of [queue, cache]) expect(block).toContain('--requirepass')
    expect(queue).toContain('--maxmemory-policy noeviction')
    expect(queue).toContain('--appendonly yes')
    expect(cache).toContain('--maxmemory-policy allkeys-lru')
    expect(cache).toContain('--appendonly no')
    expect(compose).not.toMatch(/^ {2}redis:/m)
  })

  it('数据库经连接池访问，接口与后台任务用两个最小权限账号，且拿不到迁移账号的密码', () => {
    expect(serviceBlock(compose, 'pgbouncer')).toContain('PGB_USERS')
    for (const name of ['api', 'worker']) {
      const block = serviceBlock(compose, name)
      expect(block).toMatch(/dev-database|\*database/)
      expect(block).not.toMatch(/POSTGRES_PASSWORD|DATABASE_OWNER_URL|nova_dev_password@/)
    }
    expect(compose).toContain('nova_app:')
    expect(compose).toContain('nova_system:')
    expect(compose).toContain('pgbouncer=true')
  })

  it('迁移在账号创建（roles）之后用迁移账号直连数据库，不经过连接池', () => {
    const migrate = serviceBlock(compose, 'migrate')
    expect(migrate).toContain('roles: { condition: service_completed_successfully }')
    expect(migrate).toContain('@postgres:5432')
    expect(migrate).not.toContain('pgbouncer')
    expect(serviceBlock(compose, 'roles')).toContain('/ops/roles.sql')
    expect(serviceBlock(compose, 'roles')).toContain('/ops/regrant.sql')
  })

  it('数据库开启慢查询日志，分区表需要的锁数量不少于 512', () => {
    const postgres = serviceBlock(compose, 'postgres')
    expect(postgres).toContain('log_min_duration_statement=1000')
    expect(postgres).toContain('max_locks_per_transaction=512')
  })

  it('接口与后台任务共享文件存储卷，并配置了文件存储与应用层加密', () => {
    for (const name of ['api', 'worker']) {
      expect(serviceBlock(compose, name)).toMatch(/\/data\/storage/)
    }
    expect(compose).toContain('STORAGE_SIGNING_KEY')
    expect(compose).toContain('TOKEN_ENCRYPTION_KEY')
  })
})

describe('阿里云生产环境额外约定', () => {
  const compose = read(composeFiles.阿里云)
  it('容器有内存上限，后台任务的内存守卫阈值低于容器上限', () => {
    expect(serviceBlock(compose, 'api')).toContain('mem_limit:')
    expect(serviceBlock(compose, 'worker')).toContain('mem_limit:')
    expect(compose).toContain('WORKER_RSS_LIMIT_MB: ${WORKER_RSS_LIMIT_MB:-1700}')
    expect(compose).toContain('${WORKER_MEM_LIMIT:-2g}')
  })

  it('队列 Redis 沿用原数据卷，升级不丢未消费的任务', () => {
    expect(serviceBlock(compose, 'queue-redis')).toContain('nova-aliyun-redis:/data')
  })

  it('必填密码缺失时拒绝启动', () => {
    for (const name of ['POSTGRES_PASSWORD', 'NOVA_APP_PASSWORD', 'NOVA_SYSTEM_PASSWORD', 'QUEUE_REDIS_PASSWORD', 'CACHE_REDIS_PASSWORD', 'JWT_SECRET']) {
      expect(compose).toContain(`\${${name}:?`)
    }
  })

  it('环境变量示例里有全部部署变量，且没有真实密码', () => {
    const example = read('.env.aliyun.example')
    for (const name of ['NOVA_APP_PASSWORD', 'NOVA_SYSTEM_PASSWORD', 'QUEUE_REDIS_PASSWORD', 'CACHE_REDIS_PASSWORD', 'STORAGE_SIGNING_KEY', 'DB_REQUIRE_TLS', 'TRUST_PROXY'])
      expect(example).toContain(name)
    expect(example).not.toMatch(/^(POSTGRES|NOVA_APP|NOVA_SYSTEM|QUEUE_REDIS|CACHE_REDIS)_PASSWORD=(?!REPLACE_)/m)
  })
})

describe('镜像构建覆盖全部工作区依赖', () => {
  const dependsOn = (app: string) => {
    const manifest = JSON.parse(read(`apps/${app}/package.json`)) as { dependencies?: Record<string, string> }
    return Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@nova/'))
  }

  it.each([
    ['api', 'api.Dockerfile'],
    ['worker', 'worker.Dockerfile'],
  ])('%s 依赖的每个工作区包都在镜像里构建', (app, dockerfile) => {
    const text = read(`infrastructure/compose/${dockerfile}`)
    for (const name of dependsOn(app)) expect(text, `${dockerfile} 缺少 ${name} 的构建`).toContain(`--filter ${name} build`)
  })

  it('网关镜像复制了 packages 下全部包的清单，工作区安装结果与仓库一致', () => {
    const text = read('infrastructure/compose/web.Dockerfile')
    const packages = readdirSync(join(root, 'packages')).filter(name => existsSync(join(root, 'packages', name, 'package.json')))
    for (const name of packages) expect(text, `web.Dockerfile 缺少 packages/${name}`).toContain(`COPY packages/${name}/package.json`)
  })

  it('构建上下文排除了各层 node_modules 与 dist（避免把宿主机的产物带进镜像）', () => {
    const ignore = read('.dockerignore')
    expect(ignore).toContain('**/node_modules')
    expect(ignore).toContain('**/dist')
  })
})

describe('连接池与账号脚本', () => {
  it('roles.sql 密码只来自环境变量，包含语句超时；regrant.sql 不含密码', () => {
    const roles = read('database/ops/roles.sql')
    expect(roles).toContain('NOVA_APP_PASSWORD')
    expect(roles).toContain('statement_timeout')
    expect(roles).not.toMatch(/PASSWORD '[^']+'/)
    expect(read('database/ops/regrant.sql')).not.toMatch(/PASSWORD/i)
  })

  it('连接池使用事务池模式与 SCRAM 认证', () => {
    const script = read('infrastructure/compose/pgbouncer/entrypoint.sh')
    expect(script).toContain('pool_mode = transaction')
    expect(script).toContain('auth_type = scram-sha-256')
  })
})
