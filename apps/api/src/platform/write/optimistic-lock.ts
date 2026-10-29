import { VersionBodySchema } from '@nova/api-contracts'
import { appError } from '../http'

// 乐观锁（10.1、P1-15）：多人会编辑的对象带 version，更新必须“带着自己看到的版本去改”。
// 版本已被别人推进时更新不会生效，返回 409 CONFLICT，前端提示用户刷新或合并后重试。

type Where = Record<string, unknown>

/** Prisma 模型代理里本模块用到的两个方法（任何带 version 列的模型都满足）。 */
// 参数类型写成 never：任何具体模型代理（参数类型各不相同）都能传入；内部再按下面的宽松形状调用。
export interface VersionedDelegate<Row> {
  updateMany(args: never): Promise<{ count: number }>
  findFirst(args: never): Promise<Row | null>
}

interface LooseDelegate<Row> {
  updateMany(args: { where: Where; data: Where }): Promise<{ count: number }>
  findFirst(args: { where: Where; include?: unknown; select?: unknown }): Promise<Row | null>
}

export interface VersionedUpdateOptions {
  /** 对象的中文名称，用于错误提示，如“采购单”。 */
  label?: string
  include?: unknown
  select?: unknown
}

/** 从请求体取出调用方看到的版本号；缺失或不合法返回 422（字段级错误指向 version）。 */
export function expectedVersionFrom(body: unknown): number {
  const parsed = VersionBodySchema.safeParse({ version: (body as { version?: unknown } | null | undefined)?.version })
  if (!parsed.success) {
    throw appError('VALIDATION_FAILED', '更新必须带上当前看到的版本号 version', { fieldErrors: { version: ['必须是不小于 1 的整数'] } })
  }
  return parsed.data.version
}

/**
 * 带版本号的更新：只有对象仍处于 expectedVersion 时才生效，并把版本加一。
 * 一条语句完成“比较并更新”，并发时只有一个会成功。
 * - 对象不存在（或不属于当前企业，由 where 保证）：404
 * - 版本不一致：409 CONFLICT，details 带当前版本号，便于前端提示
 * 返回更新后的最新记录。
 */
export async function updateWithVersion<Row extends { version: number }>(
  model: VersionedDelegate<Row>,
  where: Where,
  expectedVersion: number,
  data: Where,
  options: VersionedUpdateOptions = {},
): Promise<Row> {
  if ('version' in data) throw new Error('updateWithVersion 不允许调用方自行设置 version')
  const delegate = model as unknown as LooseDelegate<Row>
  const label = options.label ?? '对象'
  const result = await delegate.updateMany({ where: { ...where, version: expectedVersion }, data: { ...data, version: { increment: 1 } } })
  if (result.count === 0) {
    const current = await delegate.findFirst({ where, select: { version: true } })
    if (!current) throw appError('RESOURCE_NOT_FOUND', `${label}不存在`)
    throw appError('CONFLICT', `${label}已被他人修改，请刷新后查看最新内容，再决定是否合并你的修改`, {
      details: { currentVersion: (current as { version: number }).version, expectedVersion },
    })
  }
  const fresh = await delegate.findFirst({ where, include: options.include, select: options.select })
  // 极端情况：更新后对象被他人删除
  if (!fresh) throw appError('RESOURCE_NOT_FOUND', `${label}不存在`)
  return fresh
}
