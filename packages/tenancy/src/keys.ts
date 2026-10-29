import { TenantIsolationError } from './context.js'

// 缓存键与对象存储路径都以租户编号开头（12.8 第 4、6 条），从形式上杜绝跨租户串用。

const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function assertTenantId(tenantId: string) {
  if (!TENANT_ID.test(tenantId)) throw new TenantIsolationError('TENANT_MISMATCH', '租户编号格式不合法')
}

function assertSegment(value: string, label: string) {
  if (!SEGMENT.test(value) || value.includes('..')) throw new TenantIsolationError('TENANT_MISMATCH', `${label}含有不允许的字符`)
}

/** 缓存键：`t:租户编号:...`。各部分不得含冒号，避免拼接歧义。 */
export function tenantCacheKey(tenantId: string, ...parts: Array<string | number>): string {
  assertTenantId(tenantId)
  if (parts.length === 0) throw new TenantIsolationError('TENANT_MISMATCH', '缓存键至少要有一个业务部分')
  const segments = parts.map(part => String(part))
  for (const segment of segments) {
    if (segment === '' || segment.includes(':')) throw new TenantIsolationError('TENANT_MISMATCH', '缓存键的业务部分不能为空或含冒号')
  }
  return `t:${tenantId}:${segments.join(':')}`
}

/** 是否是该租户的缓存键（读取缓存后复核用）。 */
export function isTenantCacheKey(key: string, tenantId: string): boolean {
  return key.startsWith(`t:${tenantId}:`)
}

export interface ObjectKeyInput {
  tenantId: string
  /** 数据域，如 reports、exports、raw-files。 */
  domain: string
  /** 业务日期（UTC），决定“年/月/日”目录。 */
  date: Date
  /** 文件名，不含目录。 */
  name: string
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 对象存储路径：租户 / 数据域 / 日期 / 文件名。 */
export function tenantObjectKey(input: ObjectKeyInput): string {
  assertTenantId(input.tenantId)
  assertSegment(input.domain, '数据域')
  assertSegment(input.name, '文件名')
  if (Number.isNaN(input.date.getTime())) throw new TenantIsolationError('TENANT_MISMATCH', '日期不合法')
  const date = input.date
  return `tenants/${input.tenantId}/${input.domain}/${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${input.name}`
}

/** 校验对象路径属于该租户；不属于一律按“不存在”处理，调用方不得区分原因。 */
export function objectKeyBelongsToTenant(key: string, tenantId: string): boolean {
  assertTenantId(tenantId)
  if (key.includes('..') || key.includes('\\') || key.startsWith('/')) return false
  return key.startsWith(`tenants/${tenantId}/`)
}
