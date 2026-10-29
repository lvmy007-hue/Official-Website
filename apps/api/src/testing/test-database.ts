import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client } from 'pg'

// 接口集成测试用的真实 PostgreSQL（与生产同为 16 版本），按需启动、用完销毁。
// 不依赖外部数据库或容器；持续集成与本机行为一致。
//
// 直接驱动 initdb / postgres 而不是 embedded-postgres 的封装，原因：
// PostgreSQL 在 Windows 上，当程序所在路径含非 ASCII 字符（例如本项目的“官网”目录）时，
// initdb 的初始化阶段会因编码不一致失败。这里在路径含非 ASCII 字符时，把二进制复制到纯 ASCII 缓存目录再运行。

const require = createRequire(__filename)
const exe = platform() === 'win32' ? '.exe' : ''

export type DatabaseRole = 'admin' | 'app' | 'system'

// 与生产一致的两个连接账号（database/ops/roles.sql）：迁移在管理员账号下执行，接口与后台任务用下面两个账号连接。
export const APP_ROLE = { name: 'nova_app', password: 'nova_app_test' }
export const SYSTEM_ROLE = { name: 'nova_system', password: 'nova_system_test' }

export type TestDatabase = {
  /** 管理员连接串（可建库、改结构）。 */
  adminUrl: string
  /** 连接串。admin 是集群管理员（建库、迁移、造数）；app 是租户连接（受行级安全约束的普通账号）；system 是系统连接（可绕过行级安全）。 */
  urlFor(database: string, role?: DatabaseRole): string
  createDatabase(name: string): Promise<void>
  /** 对指定数据库执行全部迁移（与生产一致：prisma migrate deploy）。 */
  migrate(database: string): void
  connect(database: string): Promise<Client>
  stop(): Promise<void>
}

const isAscii = (value: string) => /^[\x20-\x7e]+$/.test(value)

function nativeDir(): string {
  const carrier = require.resolve('embedded-postgres')
  const osName = platform() === 'win32' ? 'windows' : platform()
  const entry = createRequire(carrier).resolve(`@embedded-postgres/${osName}-${arch()}`)
  return join(dirname(entry), '..', 'native')
}

/** 返回可直接运行的 PostgreSQL 目录（路径保证为 ASCII）。 */
function runnableBinaries(): string {
  const source = nativeDir()
  if (isAscii(source)) return source
  const cacheRoot = process.env.NOVA_PG_CACHE_DIR ?? join(tmpdir(), 'nova-pg-bin')
  // 目录名带上版本，升级二进制后不会误用旧缓存
  const version = /embedded-postgres@([^/\\]+)/.exec(source)?.[1] ?? 'local'
  const target = join(cacheRoot, `${version}-${platform()}-${arch()}`)
  if (!isAscii(target)) throw new Error(`请通过环境变量 NOVA_PG_CACHE_DIR 指定一个纯英文路径，当前缓存路径含非英文字符：${target}`)
  if (!existsSync(join(target, 'bin', `postgres${exe}`))) {
    mkdirSync(cacheRoot, { recursive: true })
    cpSync(source, target, { recursive: true, verbatimSymlinks: true })
  }
  return target
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (address && typeof address === 'object' ? resolvePort(address.port) : reject(new Error('无法分配端口'))))
    })
  })
}

const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

class PortTakenError extends Error {}

/** 路径比较用：统一斜杠与大小写（Windows 上 SHOW data_directory 返回正斜杠）。 */
const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

/**
 * 并发测试可能挑到同一个空闲端口（挑选与监听之间有间隙），输的一方会连上赢的一方的数据库，
 * 导致后面创建账号报“已存在”。这里校验连上的确实是自己的数据目录，不是就换端口重试。
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await startTestDatabaseOnce()
    } catch (error) {
      lastError = error
      await sleep(200 + Math.floor(Math.random() * 400))
    }
  }
  throw lastError
}

async function startTestDatabaseOnce(): Promise<TestDatabase> {
  const home = runnableBinaries()
  const bin = (name: string) => join(home, 'bin', `${name}${exe}`)
  const dataDir = mkdtempSync(join(tmpdir(), 'nova-pg-'))
  const port = await freePort()
  const user = 'nova_admin'
  const password = 'nova_admin_test'
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' }

  const passwordFile = join(dataDir, 'pw.txt')
  writeFileSync(passwordFile, password)
  try {
    execFileSync(bin('initdb'), ['-D', join(dataDir, 'data'), '-U', user, '--pwfile', passwordFile, '--encoding=UTF8', '--locale=C', '-A', 'scram-sha-256'], { env, stdio: 'pipe' })
  } finally {
    rmSync(passwordFile, { force: true })
  }

  const server: ChildProcess = spawn(
    bin('postgres'),
    [
      '-D',
      join(dataDir, 'data'),
      '-p',
      String(port),
      '-h',
      '127.0.0.1',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
      '-c',
      'log_min_messages=error',
      '-c',
      'timezone=UTC',
      '-c',
      'max_locks_per_transaction=512',
    ],
    { env, stdio: 'ignore', windowsHide: true },
  )

  const credentials = { admin: { name: user, password }, app: APP_ROLE, system: SYSTEM_ROLE }
  const urlFor = (database: string, role: DatabaseRole = 'admin') => `postgresql://${credentials[role].name}:${credentials[role].password}@127.0.0.1:${port}/${database}`
  const connect = async (database: string) => {
    const client = new Client({ connectionString: urlFor(database) })
    await client.connect()
    return client
  }

  // 等待服务就绪
  let ready = false
  for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`测试数据库进程提前退出（代码 ${server.exitCode}）`)
    try {
      const client = await connect('postgres')
      const directory = (await client.query('SHOW data_directory')).rows[0]?.data_directory as string | undefined
      await client.end()
      if (!directory || !samePath(directory, join(dataDir, 'data'))) throw new PortTakenError()
      ready = true
    } catch (error) {
      if (error instanceof PortTakenError) {
        server.kill()
        throw new Error('测试数据库端口被其他进程占用，换端口重试', { cause: error })
      }
      await sleep(250)
    }
  }
  if (!ready) {
    server.kill()
    throw new Error('测试数据库启动超时')
  }

  // 创建两个连接账号（集群级，必须在任何迁移之前，迁移才会给它们授权）
  const bootstrap = await connect('postgres')
  try {
    await bootstrap.query(`CREATE ROLE ${APP_ROLE.name} LOGIN PASSWORD '${APP_ROLE.password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
    await bootstrap.query(`CREATE ROLE ${SYSTEM_ROLE.name} LOGIN PASSWORD '${SYSTEM_ROLE.password}' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE`)
  } finally {
    await bootstrap.end()
  }

  return {
    adminUrl: urlFor('postgres'),
    urlFor,
    async createDatabase(name) {
      const admin = await connect('postgres')
      try {
        await admin.query(`CREATE DATABASE "${name}"`)
      } finally {
        await admin.end()
      }
    },
    migrate(database) {
      const prisma = require.resolve('prisma/build/index.js')
      execFileSync(process.execPath, [prisma, 'migrate', 'deploy', '--schema', join(__dirname, '../../../../database/prisma/schema.prisma')], {
        env: { ...process.env, DATABASE_URL: urlFor(database) },
        stdio: 'pipe',
      })
    },
    connect,
    async stop() {
      if (server.exitCode === null) {
        server.kill()
        await new Promise<void>(done => {
          server.once('exit', () => done())
          setTimeout(done, 5000)
        })
      }
      // Windows 下进程释放文件略有延迟，重试清理
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          rmSync(dataDir, { recursive: true, force: true })
          break
        } catch {
          await sleep(300)
        }
      }
    },
  }
}
