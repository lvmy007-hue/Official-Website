import { AsyncLocalStorage } from 'node:async_hooks'

// 租户上下文（12.8 第 1、2、5 条）：当前这次请求（或这一个后台任务）属于哪个租户。
// 请求入口先建立一个空的“租户槽”；身份解析完成后绑定租户编号，此后同一请求里的全部数据库访问
// 都带着这个租户：应用层自动补租户条件，数据库层用它设置行级安全变量。

export type TenantIsolationCode = 'TENANT_CONTEXT_MISSING' | 'TENANT_MISMATCH' | 'TENANT_REBIND' | 'TENANT_TRANSACTION_UNSUPPORTED'

/** 租户隔离被违反：属于代码缺陷或越权企图，调用方不得吞掉。 */
export class TenantIsolationError extends Error {
  constructor(
    public readonly code: TenantIsolationCode,
    message: string,
  ) {
    super(message)
    this.name = 'TenantIsolationError'
  }
}

export type QueryBoundCode = 'QUERY_TAKE_TOO_LARGE' | 'QUERY_ROW_LIMIT_EXCEEDED'

/** 查询没有边界（12.5）：一次返回的行数超过上限，属于代码缺陷（缺少分页或聚合），不得吞掉。 */
export class QueryBoundError extends Error {
  constructor(
    public readonly code: QueryBoundCode,
    message: string,
  ) {
    super(message)
    this.name = 'QueryBoundError'
  }
}

interface TenantSlot {
  tenantId?: string
}

const storage = new AsyncLocalStorage<TenantSlot>()

/** 请求入口使用：为这次请求建立一个尚未绑定租户的槽。 */
export function runWithTenantSlot<T>(fn: () => T): T {
  return storage.run({}, fn)
}

/** 后台任务使用：任务只带租户编号，执行时在该租户的上下文中运行。 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  if (!tenantId) throw new TenantIsolationError('TENANT_CONTEXT_MISSING', '后台任务缺少租户编号')
  return storage.run({ tenantId }, fn)
}

/** 身份解析完成后绑定租户。同一请求只能绑定一次；重复绑定到另一个租户会被拒绝。 */
export function bindTenantContext(tenantId: string): void {
  const slot = storage.getStore()
  if (!slot) throw new TenantIsolationError('TENANT_CONTEXT_MISSING', '请求没有建立租户槽（入口中间件未生效）')
  if (slot.tenantId !== undefined && slot.tenantId !== tenantId) {
    throw new TenantIsolationError('TENANT_REBIND', '同一请求不允许切换租户')
  }
  slot.tenantId = tenantId
}

export function currentTenantId(): string | undefined {
  return storage.getStore()?.tenantId
}

export function requireTenantId(): string {
  const tenantId = currentTenantId()
  if (!tenantId) throw new TenantIsolationError('TENANT_CONTEXT_MISSING', '当前没有租户上下文，不能访问租户数据')
  return tenantId
}
