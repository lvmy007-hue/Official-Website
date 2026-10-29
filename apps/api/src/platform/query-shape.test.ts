import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { hasNonStringQuery, queryShapeGuard } from './query-shape'

describe('hasNonStringQuery', () => {
  it('全是字符串（含空串）：通过', () => {
    expect(hasNonStringQuery({})).toBe(false)
    expect(hasNonStringQuery({ a: '1', b: '', c: 'x,y' })).toBe(false)
  })

  it('数组、嵌套对象、空值：都拒绝', () => {
    expect(hasNonStringQuery({ a: ['1', '2'] })).toBe(true)
    expect(hasNonStringQuery({ a: { $ne: '1' } })).toBe(true)
    expect(hasNonStringQuery({ a: { b: { c: '1' } } })).toBe(true)
    expect(hasNonStringQuery({ a: undefined })).toBe(true)
    expect(hasNonStringQuery({ a: null })).toBe(true)
  })

  it('只要有一个不合格就拒绝', () => {
    expect(hasNonStringQuery({ a: '1', b: ['2'] })).toBe(true)
  })
})

describe('queryShapeGuard', () => {
  function run(query: unknown) {
    const json = vi.fn()
    const status = vi.fn(() => ({ json }))
    const next = vi.fn() as unknown as NextFunction
    queryShapeGuard({ query, requestId: 'req-1' } as unknown as Request, { status } as unknown as Response, next)
    return { status, json, next }
  }

  it('合格：放行，不写响应', () => {
    const { status, next } = run({ page: '2' })
    expect(next).toHaveBeenCalledOnce()
    expect(status).not.toHaveBeenCalled()
  })

  it('不合格：400 与统一错误结构，不放行', () => {
    const { status, json, next } = run({ q: { $ne: '1' } })
    expect(next).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(400)
    expect(json.mock.calls[0][0]).toMatchObject({ success: false, error: { code: 'BAD_REQUEST', retryable: false } })
  })
})
