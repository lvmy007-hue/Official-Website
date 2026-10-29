import { z } from 'zod'

/**
 * 升级 zod 4 后，没有写自定义文案的默认校验消息保持与 zod 3 一致（接口 422 的 fieldErrors 文案不变，X-01）。
 * 只由接口服务启动时调用一次；前端不调用，会被打包工具丢掉，不占首屏体积。
 * 带自定义文案（中文）的校验不经过这里：schema 自己的 error 优先于全局配置。
 * 返回 undefined 表示沿用 zod 4 的默认文案（联合类型、判别联合的取值提示两个版本本来就一致）。
 */

type Issue = {
  code: string
  input?: unknown
  expected?: string
  origin?: string
  minimum?: number | bigint
  maximum?: number | bigint
  inclusive?: boolean
  exact?: boolean
  values?: readonly unknown[]
  keys?: readonly string[]
  divisor?: number
  format?: string
  prefix?: string
  suffix?: string
  includes?: string
  options?: unknown
}

/** zod 3 的 getParsedType 名称。 */
function parsedTypeOf(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'number') return Number.isNaN(value) ? 'nan' : 'number'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Date) return 'date'
  if (value instanceof Map) return 'map'
  if (value instanceof Set) return 'set'
  if (value instanceof Promise) return 'promise'
  return typeof value
}

const quoted = (values: readonly unknown[], separator: string) => values.map(value => (typeof value === 'string' ? `'${value}'` : String(value))).join(separator)

function sizeText(issue: Issue, bound: number | bigint | undefined, wording: { exact: string; inclusive: string; exclusive: string }) {
  return `${issue.exact ? wording.exact : issue.inclusive === false ? wording.exclusive : wording.inclusive} ${String(bound)}`
}

function rangeMessage(issue: Issue, upper: boolean): string | undefined {
  const bound = upper ? issue.maximum : issue.minimum
  const origin = issue.origin
  if (origin === 'array' || origin === 'set') {
    const words = upper ? { exact: 'exactly', inclusive: 'at most', exclusive: 'less than' } : { exact: 'exactly', inclusive: 'at least', exclusive: 'more than' }
    return `Array must contain ${sizeText(issue, bound, words)} element(s)`
  }
  if (origin === 'string') {
    const words = upper ? { exact: 'exactly', inclusive: 'at most', exclusive: 'under' } : { exact: 'exactly', inclusive: 'at least', exclusive: 'over' }
    return `String must contain ${sizeText(issue, bound, words)} character(s)`
  }
  if (origin === 'number' || origin === 'int') {
    const words = upper
      ? { exact: 'exactly', inclusive: 'less than or equal to', exclusive: 'less than' }
      : { exact: 'exactly equal to', inclusive: 'greater than or equal to', exclusive: 'greater than' }
    return `Number must be ${sizeText(issue, bound, words)}`
  }
  return undefined
}

const FORMAT_NAMES: Record<string, string> = { ipv4: 'ip', ipv6: 'ip', cidrv4: 'cidr', cidrv6: 'cidr', e164: 'e164' }

function formatMessage(issue: Issue): string | undefined {
  const format = issue.format ?? ''
  if (format === 'regex') return 'Invalid'
  if (format === 'starts_with') return `Invalid input: must start with "${issue.prefix}"`
  if (format === 'ends_with') return `Invalid input: must end with "${issue.suffix}"`
  if (format === 'includes') return `Invalid input: must include "${issue.includes}"`
  return `Invalid ${FORMAT_NAMES[format] ?? format}`
}

export function legacyZodMessage(issue: Issue): string | undefined {
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.input === undefined) return 'Required'
      const expected = issue.expected === 'int' ? 'integer' : issue.expected
      const received = issue.expected === 'int' && typeof issue.input === 'number' ? 'float' : parsedTypeOf(issue.input)
      return `Expected ${expected}, received ${received}`
    }
    case 'invalid_value': {
      const values = issue.values ?? []
      if (values.length === 1) return `Invalid literal value, expected ${JSON.stringify(values[0])}`
      if (issue.input === undefined) return 'Required'
      if (typeof issue.input !== 'string') return `Expected ${quoted(values, ' | ')}, received ${parsedTypeOf(issue.input)}`
      return `Invalid enum value. Expected ${quoted(values, ' | ')}, received '${issue.input}'`
    }
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${quoted(issue.keys ?? [], ', ')}`
    case 'too_small':
      return rangeMessage(issue, false)
    case 'too_big':
      return rangeMessage(issue, true)
    case 'invalid_format':
      return formatMessage(issue)
    case 'not_multiple_of':
      return `Number must be a multiple of ${issue.divisor}`
    case 'invalid_union':
      return Array.isArray(issue.options) && issue.options.length > 0 ? undefined : 'Invalid input'
    default:
      return undefined
  }
}

/** 接口服务启动时调用：让契约包里的 zod 使用 zod 3 风格的默认文案。可重复调用。 */
export function installLegacyZodMessages(): void {
  z.config({ customError: issue => legacyZodMessage(issue as unknown as Issue) })
}
