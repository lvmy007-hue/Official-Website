import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PII_FORBIDDEN_KEYS, PII_GUARD_ALLOWED_SOURCE_DIRS, PII_REDACT_KEYS, isGuardAllowedPath, scanLogCalls, scanResponse, scanSourceForPiiKeys } from '@nova/api-contracts'
import { LOG_REDACT_KEYS as API_REDACT_KEYS } from './platform/observability/logger'
import { PiiLeakError, assertNoPiiLeak, clearPiiSentinels, registerPiiSentinel } from './testing/pii-response-guard'

// 个人信息守卫（P6-14，CI 守卫）：
//   1. 响应：测试工具 call 的每个响应都过 assertNoPiiLeak（除 POST /pii/reveal）；
//   2. 导出模板：导出相关源码里不许出现个人信息字段名；
//   3. 日志：日志调用的参数里不许出现个人信息字段名，两个服务的日志脱敏键必须覆盖全部个人信息键；
//   4. 每一条守卫都有“故意泄露必须失败”的反向用例，防止守卫自己失灵。

const API_SRC = __dirname
const WORKER_SRC = join(__dirname, '..', '..', 'worker', 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const isProduction = (file: string) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !/\.test-helper\.tsx?$/.test(file) && !file.includes(`${sep}testing${sep}`)
const rel = (root: string, file: string) => relative(root, file).split(sep).join('/')
const allowedSource = (root: string, file: string) => PII_GUARD_ALLOWED_SOURCE_DIRS.some(dir => rel(root, file).startsWith(dir))

const apiFiles = walk(API_SRC).filter(isProduction)
const workerFiles = walk(WORKER_SRC).filter(isProduction)

describe('个人信息守卫：响应', () => {
  it('响应里出现个人信息字段名（任意深度、任意大小写与下划线写法）都被找出', () => {
    expect(scanResponse({ data: { items: [{ id: 1, buyerEmail: 'x' }] } })).toEqual([{ where: 'data.items[0].buyerEmail', what: 'buyerEmail' }])
    expect(scanResponse({ BUYER_PHONE: 'x' })).toHaveLength(1)
    expect(scanResponse({ 'customer-comments': 'x' })).toHaveLength(1) // 比较前会去掉连字符与下划线
    expect(scanResponse({ customerComments: 'x', piiCiphertext: 'y' })).toHaveLength(2)
  })

  it('登记过的明文出现在响应任何位置都算泄露；没有泄露的正常响应放行', () => {
    expect(scanResponse({ note: '收件人 Alice Pii Buyer 来电' }, ['Alice Pii Buyer'])).toHaveLength(1)
    expect(scanResponse({ items: [{ id: 'a', status: 'Shipped', amazonOrderId: '111-2222222-3333333' }] }, ['Alice Pii Buyer'])).toEqual([])
  })

  it('只有 POST /pii/reveal 是例外；别的路径（含相似前缀）都不是', () => {
    expect(isGuardAllowedPath('/api/v1/pii/reveal')).toBe(true)
    expect(isGuardAllowedPath('/pii/reveal?x=1')).toBe(true)
    for (const path of ['/pii/reveals', '/orders/o1/pii/reveal', '/pii', '/api/v1/orders/o1']) expect(isGuardAllowedPath(path), path).toBe(false)
  })

  it('反向用例：测试工具的守卫遇到故意泄露必须抛错', () => {
    clearPiiSentinels()
    expect(() => assertNoPiiLeak('GET', '/orders/o1', { data: { buyerName: 'x' } })).toThrow(PiiLeakError)
    registerPiiSentinel('Secret Buyer 77')
    expect(() => assertNoPiiLeak('GET', '/returns', { data: { items: [{ reason: 'Secret Buyer 77' }] } })).toThrow(/个人信息泄露/)
    expect(() => assertNoPiiLeak('GET', '/orders/o1', { data: { ok: true } })).not.toThrow()
    // 统一出口自己可以返回明文
    expect(() => assertNoPiiLeak('POST', '/api/v1/pii/reveal', { data: { values: { buyerName: 'Secret Buyer 77' } } })).not.toThrow()
    clearPiiSentinels()
  })

  it('两套测试工具的 call 都接了守卫（不接就等于没有）', () => {
    for (const name of ['harness.ts', 'db-harness.ts']) {
      const source = readFileSync(join(API_SRC, 'testing', name), 'utf8')
      expect(source, name).toMatch(/assertNoPiiLeak\(/)
    }
  })
})

describe('个人信息守卫：导出模板', () => {
  const exportFiles = [...apiFiles.filter(file => rel(API_SRC, file).startsWith('modules/exports/')), ...workerFiles.filter(file => rel(WORKER_SRC, file).startsWith('exports/'))]

  it('导出相关源码（接口与后台任务）里没有个人信息字段名', () => {
    expect(exportFiles.length).toBeGreaterThan(10)
    const findings = exportFiles.flatMap(file => scanSourceForPiiKeys(readFileSync(file, 'utf8')).map(item => `${file} ${item.where} ${item.what}`))
    expect(findings).toEqual([])
  })

  it('反向用例：导出模板里加一列买家邮箱、电话或备注，扫描必须报出', () => {
    const leaky = ["const columns = ['orderId', 'buyerEmail']", 'select: { buyerPhone: true }', "header: 'customer-comments'", 'const row = { customerName: o.name }']
    for (const line of leaky) expect(scanSourceForPiiKeys(line), line).toHaveLength(1)
    expect(scanSourceForPiiKeys("const columns = ['orderId', 'asin', 'sku']")).toEqual([])
  })
})

describe('个人信息守卫：日志', () => {
  it('接口与后台任务的日志调用里没有个人信息字段名（查看明文的模块除外）', () => {
    const findings = [
      ...apiFiles.filter(file => !allowedSource(API_SRC, file)).flatMap(file => scanLogCalls(readFileSync(file, 'utf8')).map(item => `api/${rel(API_SRC, file)} ${item.where} ${item.what}`)),
      ...workerFiles.flatMap(file => scanLogCalls(readFileSync(file, 'utf8')).map(item => `worker/${rel(WORKER_SRC, file)} ${item.where} ${item.what}`)),
    ]
    expect(findings).toEqual([])
  })

  it('两个服务的日志脱敏键都覆盖全部个人信息键', async () => {
    // 后台任务的日志模块在另一个包里，api 的类型检查不让直接引用，动态载入（同 pii.db.test.ts 的做法）
    const worker = (await import(/* @vite-ignore */ String('../../worker/src/logger'))) as { LOG_REDACT_KEYS: readonly string[] }
    for (const [name, keys] of [
      ['api', API_REDACT_KEYS],
      ['worker', worker.LOG_REDACT_KEYS],
    ] as const) {
      const missing = PII_REDACT_KEYS.filter(key => !keys.includes(key))
      expect(missing, `${name} 日志脱敏缺少这些键`).toEqual([])
    }
    expect(PII_REDACT_KEYS).toEqual(expect.arrayContaining([...PII_FORBIDDEN_KEYS]))
  })

  it('反向用例：日志调用里带上买家信息或备注，扫描必须报出；没有就放行', () => {
    const leaky = [
      'logger.info({ buyerEmail: row.buyerEmail }, "sync")',
      'this.logger.warn(`comment ${row.customerComments}`)',
      'ctx.logger.error({ err, customerComments }, "failed")',
      'console.log(order.buyerName)',
      'deps.logger.info({ detail: { nested: { piiCiphertext: x } } })',
    ]
    for (const source of leaky) expect(scanLogCalls(source), source).toHaveLength(1)
    expect(scanLogCalls('logger.info({ tenantId, scanned, encrypted }, "ok")')).toEqual([])
    // 日志调用之外提到字段名不属于这一条守卫（那是源码扫描的事）
    expect(scanLogCalls('const x = row.buyerEmail')).toEqual([])
  })
})
