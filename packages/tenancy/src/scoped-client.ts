import { QueryBoundError, TenantIsolationError, currentTenantId } from './context.js'

// 统一数据访问层（12.8 第 1、2 条）。
//
// 应用层：对带 tenantId 列的模型，所有读、改、删自动补上租户条件；创建与更新里出现的“别的租户”会被直接拒绝。
// 数据库层：每次访问都在事务里先设置 app.tenant_id，行级安全策略据此只放行该租户的行。
// 没有租户上下文时，访问租户模型直接报错（宁可失败，不可越界）。
//
// 本模块不依赖 Prisma 的类型，接口服务与后台任务共用；底层客户端由调用方传入。

type AnyArgs = Record<string, any>

export interface ModelCatalog {
  /** 全部模型名（Prisma 模型名，如 PurchaseOrder）。 */
  allModels: readonly string[]
  /** 带 tenantId 列的模型。 */
  tenantModels: ReadonlySet<string>
  /** 每个模型的关系字段名（创建时用来判断能否直接补 tenantId 标量）。 */
  relationFields: ReadonlyMap<string, ReadonlySet<string>>
}

export interface ScopedClientOptions {
  catalog: ModelCatalog
  /** 行级安全使用的会话变量名。 */
  settingName?: string
  /**
   * 独立数据库接入点（12.8 第 11 条）：按租户返回底层客户端。
   * 默认全部租户共用传入的客户端；大客户使用独立库时，在这里返回对应库的客户端，业务代码不变。
   */
  resolveClient?: (tenantId: string | undefined) => unknown
  /**
   * 查询必须有边界（12.5）：findMany 不带 take 时自动限定为 maxRows + 1 行，实际返回超过 maxRows 行直接报错；
   * 带了 take 但超过 maxRows 同样报错。不设置则不检查（系统流程、批处理按需自行分批）。
   */
  maxRows?: number
  /**
   * 语句超时（毫秒，P1-25）：每次带租户的数据库操作都在自己的事务里先设置租户变量，同一条语句里顺带设置事务级语句超时，
   * 超时的语句被数据库取消（不会占着连接拖垮其他租户）。不设置则沿用数据库账号上的默认值。事务级设置对 PgBouncer 事务池同样有效。
   */
  statementTimeoutMs?: number
}

interface TenantSetting {
  name: string
  statementTimeoutMs?: number
}

/** 从 Prisma 的数据模型描述（Prisma.dmmf.datamodel）生成模型目录。 */
export function catalogFromDatamodel(datamodel: { models: ReadonlyArray<{ name: string; fields: ReadonlyArray<{ name: string; kind: string }> }> }): ModelCatalog {
  const tenantModels = new Set<string>()
  const relationFields = new Map<string, ReadonlySet<string>>()
  for (const model of datamodel.models) {
    if (model.fields.some(field => field.name === 'tenantId' && field.kind === 'scalar')) tenantModels.add(model.name)
    relationFields.set(model.name, new Set(model.fields.filter(field => field.kind === 'object').map(field => field.name)))
  }
  return { allModels: datamodel.models.map(model => model.name), tenantModels, relationFields }
}

const DEFAULT_SETTING = 'app.tenant_id'

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
])
const WRITE_DATA_OPERATIONS = new Set(['update', 'updateMany'])
const ALL_OPERATIONS = new Set([...WHERE_OPERATIONS, 'create', 'createMany', 'createManyAndReturn'])
const RAW_METHODS = new Set(['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'])

const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1)

const mismatch = (model: string, detail: string) => new TenantIsolationError('TENANT_MISMATCH', `${model}：${detail}`)

/** 给查询条件补上租户。条件里已有别的租户编号时直接拒绝；是过滤器对象时与当前租户取交集。 */
export function scopeWhere(where: AnyArgs | undefined, tenantId: string, model: string): AnyArgs {
  const current = where?.tenantId
  if (current === undefined) return { ...(where ?? {}), tenantId }
  if (current === tenantId) return where as AnyArgs
  if (typeof current === 'string') throw mismatch(model, '查询条件指定了其他租户')
  return { AND: [where, { tenantId }] }
}

function scalarValue(value: unknown): unknown {
  // update 数据里 { set: x } 与直接写 x 等价
  return value !== null && typeof value === 'object' && 'set' in (value as object) ? (value as { set: unknown }).set : value
}

/** 创建数据：补上租户；写了别的租户则拒绝。用关系写法（connect）创建时无法补标量，交给行级安全的校验兜底。 */
export function scopeCreateData(data: AnyArgs, tenantId: string, model: string, relationFields: ReadonlySet<string> | undefined): AnyArgs {
  if (data.tenantId !== undefined && data.tenantId !== tenantId) throw mismatch(model, '创建数据指定了其他租户')
  const connected = data.tenant?.connect?.id
  if (connected !== undefined && connected !== tenantId) throw mismatch(model, '创建数据关联了其他租户')
  if (data.tenantId !== undefined) return data
  const usesRelations = relationFields ? Object.keys(data).some(key => relationFields.has(key) && key !== 'tenant') : false
  if (data.tenant !== undefined || usesRelations) return data
  return { ...data, tenantId }
}

function scopeUpdateData(data: AnyArgs | undefined, tenantId: string, model: string) {
  if (!data) return
  const next = scalarValue(data.tenantId)
  if (next !== undefined && next !== tenantId) throw mismatch(model, '不允许把数据改到其他租户')
  const connected = data.tenant?.connect?.id
  if (connected !== undefined && connected !== tenantId) throw mismatch(model, '不允许把数据改到其他租户')
}

/** 把一次模型操作的参数改写为带租户的参数（纯函数，便于测试）。 */
export function scopeArguments(operation: string, args: AnyArgs | undefined, tenantId: string, model: string, relationFields: ReadonlySet<string> | undefined): AnyArgs {
  const next: AnyArgs = { ...(args ?? {}) }
  if (WHERE_OPERATIONS.has(operation)) next.where = scopeWhere(next.where, tenantId, model)
  if (WRITE_DATA_OPERATIONS.has(operation)) scopeUpdateData(next.data, tenantId, model)
  if (operation === 'create') next.data = scopeCreateData(next.data ?? {}, tenantId, model, relationFields)
  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    next.data = Array.isArray(next.data) ? next.data.map((row: AnyArgs) => scopeCreateData(row, tenantId, model, relationFields)) : scopeCreateData(next.data ?? {}, tenantId, model, relationFields)
  }
  if (operation === 'upsert') {
    next.create = scopeCreateData(next.create ?? {}, tenantId, model, relationFields)
    scopeUpdateData(next.update, tenantId, model)
  }
  return next
}

/**
 * 给 findMany 加边界（纯函数，便于测试）：
 * - 显式 take 超过上限：立刻报错，不发查询；
 * - 没有 take：自动改为 maxRows + 1，返回的行数超过 maxRows 说明查询没有边界，由 check 报错。
 */
export function boundFindMany(args: AnyArgs | undefined, maxRows: number, model: string): { args: AnyArgs; check?: (rows: unknown) => void } {
  const take = args?.take
  if (typeof take === 'number') {
    if (Math.abs(take) > maxRows) throw new QueryBoundError('QUERY_TAKE_TOO_LARGE', `${model}：take=${take} 超过单次查询上限 ${maxRows} 行，请分页或改用聚合`)
    return { args: args as AnyArgs }
  }
  return {
    args: { ...(args ?? {}), take: maxRows + 1 },
    check: rows => {
      if (Array.isArray(rows) && rows.length > maxRows) throw new QueryBoundError('QUERY_ROW_LIMIT_EXCEEDED', `${model}：查询返回超过 ${maxRows} 行，查询必须带分页或聚合`)
    },
  }
}

interface PrismaLike {
  $transaction: (arg: any, options?: any) => Promise<any>
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>
  [key: string]: any
}

const setTenant = (client: PrismaLike, setting: TenantSetting, tenantId: string) =>
  setting.statementTimeoutMs
    ? client.$queryRaw`SELECT set_config(${setting.name}, ${tenantId}, true), set_config('statement_timeout', ${String(setting.statementTimeoutMs)}, true)`
    : client.$queryRaw`SELECT set_config(${setting.name}, ${tenantId}, true)`

const SCOPED = Symbol('nova.scopedCall')

/**
 * 一次尚未执行的、带租户的数据库操作。
 * 单独 await：在一个事务里先设置租户变量再执行；放进 $transaction([...]) 数组：与其他操作同在一个事务，只设置一次。
 */
class ScopedCall<T> implements PromiseLike<T> {
  readonly [SCOPED] = true
  private started?: Promise<T>

  constructor(
    private readonly client: PrismaLike,
    private readonly setting: TenantSetting,
    readonly tenantId: string | undefined,
    private readonly make: () => PromiseLike<T>,
    /** 取到结果后的检查（例如查询行数边界），失败时抛错。 */
    readonly check?: (value: T) => void,
  ) {}

  /** 取出底层（未执行的）Prisma 操作，供 $transaction 数组使用。 */
  prepared(): PromiseLike<T> {
    return this.make()
  }

  private run(): Promise<T> {
    if (!this.started) {
      const tenantId = this.tenantId
      const raw = tenantId === undefined ? Promise.resolve(this.make()) : this.client.$transaction([setTenant(this.client, this.setting, tenantId), this.make()]).then(results => results[1] as T)
      this.started = this.check
        ? raw.then(value => {
            this.check?.(value)
            return value
          })
        : raw
    }
    return this.started
  }

  then<R1 = T, R2 = never>(onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null, onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2> {
    return this.run().then(onFulfilled, onRejected)
  }

  catch<R = never>(onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R> {
    return this.run().catch(onRejected)
  }

  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.run().finally(onFinally)
  }
}

const isScopedCall = (value: unknown): value is ScopedCall<unknown> => typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[SCOPED] === true

/**
 * 为底层 Prisma 客户端套上租户隔离。返回值与原客户端类型一致，服务代码无需改动。
 * 不要把它用于“跨租户”的系统流程（登录、授权回调、后台调度）——那些用单独的系统连接。
 */
export function createTenantScopedClient<T extends object>(base: T, options: ScopedClientOptions): T {
  const setting: TenantSetting = { name: options.settingName ?? DEFAULT_SETTING, statementTimeoutMs: options.statementTimeoutMs }
  const delegates = new Map(options.catalog.allModels.map(model => [lowerFirst(model), model]))

  const underlying = (tenantId: string | undefined) => (options.resolveClient?.(tenantId) ?? base) as PrismaLike

  const wrapDelegate = (client: PrismaLike, delegateName: string, model: string, inTransaction: boolean, tenantIdOfTransaction?: string) => {
    const isTenantModel = options.catalog.tenantModels.has(model)
    const relationFields = options.catalog.relationFields.get(model)
    return new Proxy(
      {},
      {
        get(_target, operation) {
          const delegate = client[delegateName]
          if (typeof operation !== 'string' || !ALL_OPERATIONS.has(operation)) {
            const value = delegate[operation as string]
            return typeof value === 'function' ? value.bind(delegate) : value
          }
          return (args?: AnyArgs) => {
            const tenantId = inTransaction ? tenantIdOfTransaction : currentTenantId()
            if (isTenantModel && tenantId === undefined) {
              throw new TenantIsolationError('TENANT_CONTEXT_MISSING', `${model}：没有租户上下文，不能访问租户数据`)
            }
            const scopedArgs = isTenantModel && tenantId !== undefined ? scopeArguments(operation, args, tenantId, model, relationFields) : args
            const bound = options.maxRows && operation === 'findMany' ? boundFindMany(scopedArgs, options.maxRows, model) : undefined
            const scoped = bound ? bound.args : scopedArgs
            if (inTransaction) {
              const result = delegate[operation](scoped)
              return bound?.check
                ? Promise.resolve(result).then(rows => {
                    bound.check?.(rows)
                    return rows
                  })
                : result
            }
            return new ScopedCall(client, setting, tenantId, () => delegate[operation](scoped), bound?.check)
          }
        },
      },
    )
  }

  const wrapClient = (target: PrismaLike, inTransaction: boolean, tenantIdOfTransaction?: string): PrismaLike =>
    new Proxy(target, {
      get(obj, prop) {
        if (typeof prop === 'string') {
          if (prop === '$transaction' && !inTransaction) return transaction
          const model = delegates.get(prop)
          if (model) return wrapDelegate(inTransaction ? obj : underlying(currentTenantId()), prop, model, inTransaction, tenantIdOfTransaction)
          if (RAW_METHODS.has(prop) && !inTransaction) {
            return (...args: unknown[]) => {
              const tenantId = currentTenantId()
              const client = underlying(tenantId)
              return tenantId === undefined ? client[prop](...args) : new ScopedCall(client, setting, tenantId, () => client[prop](...args))
            }
          }
        }
        const value = Reflect.get(obj, prop, obj)
        return typeof value === 'function' ? value.bind(obj) : value
      },
    })

  function transaction(arg: unknown, transactionOptions?: unknown) {
    const tenantId = currentTenantId()
    const client = underlying(tenantId)
    if (typeof arg === 'function') {
      return client.$transaction(async (tx: PrismaLike) => {
        if (tenantId !== undefined) await setTenant(tx, setting, tenantId)
        return (arg as (tx: PrismaLike) => unknown)(wrapClient(tx, true, tenantId))
      }, transactionOptions)
    }
    if (!Array.isArray(arg)) return client.$transaction(arg, transactionOptions)
    const operations = arg.map(item => {
      if (!isScopedCall(item)) return item
      if (item.tenantId !== tenantId) throw new TenantIsolationError('TENANT_MISMATCH', '事务中的操作来自不同的租户上下文')
      return item.prepared()
    })
    const verify = (results: unknown[]) => {
      arg.forEach((item, index) => {
        if (isScopedCall(item)) (item.check as ((value: unknown) => void) | undefined)?.(results[index])
      })
      return results
    }
    if (tenantId === undefined) return client.$transaction(operations, transactionOptions).then(verify)
    return client.$transaction([setTenant(client, setting, tenantId), ...operations], transactionOptions).then(results => verify(results.slice(1)))
  }

  return wrapClient(base as PrismaLike, false) as unknown as T
}
