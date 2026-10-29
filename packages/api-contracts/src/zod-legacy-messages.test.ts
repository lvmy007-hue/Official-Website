import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { installLegacyZodMessages } from './zod-legacy-messages.js'

/** 取第一条校验消息；这些期望值是 zod 3 的默认文案（升级前接口 422 的 fieldErrors 内容）。 */
const first = (schema: z.ZodType, value: unknown): string => {
  const result = schema.safeParse(value)
  if (result.success) throw new Error('应当校验失败')
  return result.error.issues[0].message
}

describe('zod 默认文案保持 zod 3 风格（X-01）', () => {
  beforeAll(() => installLegacyZodMessages())

  it('缺少必填项与类型不符', () => {
    expect(first(z.object({ name: z.string() }), {})).toBe('Required')
    expect(first(z.string(), 5)).toBe('Expected string, received number')
    expect(first(z.number(), 'x')).toBe('Expected number, received string')
    expect(first(z.number(), Number.NaN)).toBe('Expected number, received nan')
    expect(first(z.array(z.string()), null)).toBe('Expected array, received null')
    expect(first(z.object({}), [])).toBe('Expected object, received array')
    expect(first(z.boolean(), undefined)).toBe('Required')
  })

  it('整数、字符串与数组长度、数值范围', () => {
    expect(first(z.number().int(), 1.5)).toBe('Expected integer, received float')
    expect(first(z.string().min(1), '')).toBe('String must contain at least 1 character(s)')
    expect(first(z.string().max(3), 'abcd')).toBe('String must contain at most 3 character(s)')
    expect(first(z.string().length(3), 'ab')).toBe('String must contain exactly 3 character(s)')
    expect(first(z.array(z.string()).min(1), [])).toBe('Array must contain at least 1 element(s)')
    expect(first(z.array(z.string()).max(1), ['a', 'b'])).toBe('Array must contain at most 1 element(s)')
    expect(first(z.number().min(1), 0)).toBe('Number must be greater than or equal to 1')
    expect(first(z.number().max(1), 2)).toBe('Number must be less than or equal to 1')
    expect(first(z.number().positive(), 0)).toBe('Number must be greater than 0')
    expect(first(z.number().negative(), 0)).toBe('Number must be less than 0')
    expect(first(z.number().multipleOf(5), 3)).toBe('Number must be a multiple of 5')
  })

  it('枚举、字面量、多余的键', () => {
    expect(first(z.enum(['A', 'B']), 'C')).toBe("Invalid enum value. Expected 'A' | 'B', received 'C'")
    expect(first(z.enum(['A', 'B']), undefined)).toBe('Required')
    expect(first(z.enum(['A', 'B']), 3)).toBe("Expected 'A' | 'B', received number")
    expect(first(z.literal('A'), 'B')).toBe('Invalid literal value, expected "A"')
    expect(first(z.object({ a: z.string() }).strict(), { a: 'x', b: 1, c: 2 })).toBe("Unrecognized key(s) in object: 'b', 'c'")
  })

  it('字符串格式', () => {
    expect(first(z.string().email(), 'x')).toBe('Invalid email')
    expect(first(z.string().url(), 'x')).toBe('Invalid url')
    expect(first(z.string().datetime(), 'x')).toBe('Invalid datetime')
    expect(first(z.string().regex(/^a$/), 'b')).toBe('Invalid')
    expect(first(z.string().startsWith('a'), 'b')).toBe('Invalid input: must start with "a"')
  })

  it('自定义文案优先，refine 没写文案时仍是 Invalid input', () => {
    expect(first(z.string().min(2, '太短'), 'a')).toBe('太短')
    expect(first(z.enum(['A'], { error: '取值不合法' }), 'B')).toBe('取值不合法')
    expect(first(z.number({ error: issue => (issue.input === undefined ? undefined : '请填写数字') }), 'x')).toBe('请填写数字')
    expect(first(z.number({ error: issue => (issue.input === undefined ? undefined : '请填写数字') }), undefined)).toBe('Required')
    expect(
      first(
        z.string().refine(() => false),
        'a',
      ),
    ).toBe('Invalid input')
    expect(first(z.union([z.string(), z.number()]), true)).toBe('Invalid input')
  })

  it('flatten 的结构不变：按第一段路径分组，对象级问题进 formErrors', () => {
    const schema = z.object({ name: z.string(), tags: z.array(z.string().min(1)) }).strict()
    const result = schema.safeParse({ tags: [''], extra: 1 })
    if (result.success) throw new Error('应当校验失败')
    expect(result.error.flatten()).toEqual({
      formErrors: ["Unrecognized key(s) in object: 'extra'"],
      fieldErrors: { name: ['Required'], tags: ['String must contain at least 1 character(s)'] },
    })
  })
})
