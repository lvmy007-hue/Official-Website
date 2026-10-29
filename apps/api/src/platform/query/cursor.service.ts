import { Injectable } from '@nestjs/common'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { canonicalize, queryConditions } from '@nova/api-contracts'
import type { CursorPageInfo, SortSpec } from '@nova/api-contracts'
import { AppError } from '../http'

// 游标分页（12 章 12.2）：以“排序字段值 + 编号”组成复合游标，服务端签名防篡改，
// 游标绑定租户与全部查询条件，条件一变游标即失效。
// 排序字段必须是非空列并有索引支撑；同值行以编号为次序，保证翻页不重不漏。

type ValueKind = 's' | 'n' | 'd' | 'x' | 'b'
type CursorPayload = { v: 1; b: string; f: string; r: 'asc' | 'desc'; t: ValueKind; k: string; i: string }

export type CursorRow = { id: string } & Record<string, unknown>

const BINDING_LENGTH = 32

function encodeValue(value: unknown): { kind: ValueKind; text: string } {
  if (value instanceof Date) return { kind: 'd', text: value.toISOString() }
  if (typeof value === 'number') return { kind: 'n', text: String(value) }
  if (typeof value === 'bigint') return { kind: 'b', text: value.toString() }
  if (typeof value === 'string') return { kind: 's', text: value }
  // Prisma.Decimal 等带 toString 的数值对象
  if (value && typeof value === 'object' && 'toFixed' in value) return { kind: 'x', text: String(value) }
  throw new AppError(500, 'CURSOR_SORT_VALUE_UNSUPPORTED', '排序字段的值类型不支持游标分页')
}

function decodeValue(kind: ValueKind, text: string): unknown {
  switch (kind) {
    case 'd':
      return new Date(text)
    case 'n':
      return Number(text)
    case 'b':
      return BigInt(text)
    default:
      return text
  }
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url')

export function bindingOf(tenantId: string, query: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalize({ tenantId, conditions: queryConditions(query) }))
    .digest('hex')
    .slice(0, BINDING_LENGTH)
}

export function createCursorCodec(key: Buffer) {
  const sign = (body: string) => createHmac('sha256', key).update(body).digest()

  return {
    encode(payload: CursorPayload): string {
      const body = b64(JSON.stringify(payload))
      return `${body}.${b64(sign(body))}`
    },
    decode(token: string): CursorPayload {
      const [body, signature, extra] = token.split('.')
      if (!body || !signature || extra !== undefined) throw invalidCursor()
      const expected = sign(body)
      const actual = Buffer.from(signature, 'base64url')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidCursor()
      try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload
        if (payload.v !== 1) throw invalidCursor()
        return payload
      } catch {
        throw invalidCursor()
      }
    },
  }
}

function invalidCursor() {
  return new AppError(400, 'CURSOR_INVALID', '翻页游标无效或查询条件已变化，请从第一页重新加载')
}

// 签名密钥：优先使用专用密钥，否则由登录签名密钥派生，二者都没有时拒绝工作。
export function resolveCursorKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const dedicated = env.CURSOR_SIGNING_KEY
  if (dedicated && dedicated.length >= 32) return Buffer.from(dedicated)
  const jwt = env.JWT_SECRET
  if (jwt && jwt.length >= 32) return createHmac('sha256', jwt).update('nova-cursor-v1').digest()
  throw new AppError(503, 'CURSOR_KEY_NOT_CONFIGURED', '翻页签名密钥尚未配置', false)
}

@Injectable()
export class CursorService {
  private codec?: ReturnType<typeof createCursorCodec>

  private get cursor() {
    return (this.codec ??= createCursorCodec(resolveCursorKey()))
  }

  /** 排序：指定字段加编号，保证次序唯一。 */
  orderBy(sort: SortSpec) {
    return [{ [sort.field]: sort.dir }, { id: sort.dir }] as Array<Record<string, 'asc' | 'desc'>>
  }

  /**
   * 下一页的查询条件片段；没有游标（第一页）返回空对象。
   * 校验签名、排序一致、查询条件一致，任一不符都按“游标无效”拒绝。
   */
  after(token: string | undefined, sort: SortSpec, binding: string): Record<string, unknown> {
    if (!token) return {}
    const payload = this.cursor.decode(token)
    if (payload.b !== binding || payload.f !== sort.field || payload.r !== sort.dir) throw invalidCursor()
    const op = sort.dir === 'asc' ? 'gt' : 'lt'
    const value = decodeValue(payload.t, payload.k)
    return { OR: [{ [sort.field]: { [op]: value } }, { [sort.field]: value, id: { [op]: payload.i } }] }
  }

  /** 把“多取一行”的查询结果切成一页，并生成下一页游标。 */
  page<T extends CursorRow>(rows: T[], options: { pageSize: number; sort: SortSpec; binding: string; approxTotal?: number | null }): { items: T[]; pageInfo: CursorPageInfo } {
    const { pageSize, sort, binding, approxTotal = null } = options
    const hasMore = rows.length > pageSize
    const items = hasMore ? rows.slice(0, pageSize) : rows
    let nextCursor: string | null = null
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1]
      const raw = last[sort.field]
      if (raw === null || raw === undefined) {
        throw new AppError(500, 'CURSOR_SORT_VALUE_NULL', '游标分页的排序字段不能为空值')
      }
      const { kind, text } = encodeValue(raw)
      nextCursor = this.cursor.encode({ v: 1, b: binding, f: sort.field, r: sort.dir, t: kind, k: text, i: last.id })
    }
    return { items, pageInfo: { pageSize, nextCursor, hasMore, approxTotal } }
  }
}
