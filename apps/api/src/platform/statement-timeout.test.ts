import { describe, expect, it } from 'vitest'
import { isStatementTimeout } from './http'
import { ERROR_CODES } from '@nova/api-contracts'

describe('数据库语句超时识别（P1-25）', () => {
  it('SQLSTATE 57014 或“取消语句”信息都识别为查询超时', () => {
    expect(isStatementTimeout(Object.assign(new Error('Raw query failed'), { meta: { code: '57014', message: 'canceling statement due to statement timeout' } }))).toBe(true)
    expect(isStatementTimeout(new Error('ERROR: canceling statement due to statement timeout'))).toBe(true)
  })

  it('其他错误与非 Error 值不识别', () => {
    expect(isStatementTimeout(new Error('connection refused'))).toBe(false)
    expect(isStatementTimeout('statement timeout')).toBe(false)
    expect(isStatementTimeout(undefined)).toBe(false)
  })

  it('错误码目录里有可重试的 504', () => {
    expect(ERROR_CODES.QUERY_TIMEOUT).toMatchObject({ status: 504, retryable: true })
  })
})
