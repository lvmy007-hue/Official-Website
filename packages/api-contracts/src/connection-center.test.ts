import { describe, expect, it } from 'vitest'
import { ERROR_CODES } from './errors'
import {
  CONNECTION_ACTIONS,
  CONNECTION_DISCONNECT_STEP_UP,
  connectionActionStates,
  connectionFailureText,
  connectionHealthCodeOf,
  derivedEvidenceOf,
  healthStatusOf,
  healthStatusOfCode,
  tokenAgeParamsOf,
  tokenExpiryOf,
} from './connection-center'
import { STEP_UP_ACTIONS } from './write'

const NOW = new Date('2026-10-20T00:00:00.000Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000)

describe('令牌预计失效', () => {
  it('没有令牌更新记录：没有令牌', () => {
    expect(tokenExpiryOf(null, 365, 30, NOW).state).toBe('NO_TOKEN')
  })
  it('没有设置授权最长年龄：不推算，并说明亚马逊没有公布有效期', () => {
    const result = tokenExpiryOf(daysAgo(10), null, 30, NOW)
    expect(result).toMatchObject({ state: 'NOT_ESTIMATED', expiresAt: null, daysLeft: null })
    expect(result.basis).toContain('没有公布固定的授权有效期')
  })
  it('设置了最长年龄：按授权时间推算，提前提醒天数内是“即将失效”，过期是“已超过”', () => {
    expect(tokenExpiryOf(daysAgo(100), 365, 30, NOW)).toMatchObject({ state: 'OK', daysLeft: 265 })
    expect(tokenExpiryOf(daysAgo(340), 365, 30, NOW)).toMatchObject({ state: 'SOON', daysLeft: 25 })
    expect(tokenExpiryOf(daysAgo(365), 365, 30, NOW)).toMatchObject({ state: 'PASSED', daysLeft: 0 })
    expect(tokenExpiryOf(daysAgo(400), 365, 30, NOW).state).toBe('PASSED')
    expect(tokenExpiryOf(daysAgo(100), 365, 30, NOW).basis).toContain('不是亚马逊公布的有效期')
  })
  it('阈值读取与评估器一致：年龄限定 30 到 3650，提前天数 1 到 365，不合法按默认', () => {
    expect(tokenAgeParamsOf({ params: { tokenMaxAgeDays: 180, warnBeforeDays: 14 } })).toEqual({ maxAgeDays: 180, warnDays: 14 })
    expect(tokenAgeParamsOf({ params: { tokenMaxAgeDays: 1, warnBeforeDays: 9999 } })).toEqual({ maxAgeDays: 30, warnDays: 365 })
    expect(tokenAgeParamsOf({ params: { tokenMaxAgeDays: null } })).toEqual({ maxAgeDays: null, warnDays: 30 })
    expect(tokenAgeParamsOf({ params: { tokenMaxAgeDays: 'x' } })).toEqual({ maxAgeDays: null, warnDays: 30 })
    expect(tokenAgeParamsOf(null)).toEqual({ maxAgeDays: null, warnDays: 30 })
    expect(tokenAgeParamsOf('坏数据')).toEqual({ maxAgeDays: null, warnDays: 30 })
  })
})

describe('失败码', () => {
  it('通用失败码用统一说明，连接专有失败码与原始接口错误用中文说明', () => {
    expect(connectionFailureText(null)).toBeNull()
    expect(connectionFailureText('AUTH_EXPIRED')).toContain('重新授权')
    expect(connectionFailureText('SLR_NOT_US')).toContain('美国站')
    expect(connectionFailureText('LWA_TOKEN_FAILED_400')).toContain('重新授权')
    expect(connectionFailureText('ADS_LWA_TOKEN_FAILED_400_invalid_grant')).toContain('重新授权')
    expect(connectionFailureText('REFRESH_TOKEN_NOT_CONFIGURED')).toContain('重新授权')
    expect(connectionFailureText('LWA_CONFIG_MISSING')).toContain('平台')
    expect(connectionFailureText('SP_API_403_{"errors":[]}')).toContain('角色')
    expect(connectionFailureText('SP_API_503_x')).toContain('暂时不可用')
    expect(connectionFailureText('SOMETHING_NEW')).toContain('健康检查')
  })
  it('接口失败归类：换取令牌失败＝授权失效；403＝缺角色；429 与 5xx＝暂时无法判断；缺少配置保留原码', () => {
    expect(connectionHealthCodeOf({ source: 'lwa', status: 400 })).toBe('AUTH_EXPIRED')
    expect(connectionHealthCodeOf({ source: 'lwa', status: 503 })).toBe('UPSTREAM_ERROR')
    expect(connectionHealthCodeOf({ source: 'lwa', status: 429 })).toBe('THROTTLE_EXHAUSTED')
    expect(connectionHealthCodeOf({ source: 'api', status: 401 })).toBe('AUTH_EXPIRED')
    expect(connectionHealthCodeOf({ source: 'api', status: 403 })).toBe('ROLE_MISSING')
    expect(connectionHealthCodeOf({ source: 'api', status: 429 })).toBe('THROTTLE_EXHAUSTED')
    expect(connectionHealthCodeOf({ source: 'api', status: 502 })).toBe('UPSTREAM_ERROR')
    expect(connectionHealthCodeOf({ message: 'LWA_CONFIG_MISSING' })).toBe('LWA_CONFIG_MISSING')
    expect(connectionHealthCodeOf({ message: 'REFRESH_TOKEN_NOT_CONFIGURED' })).toBe('REFRESH_TOKEN_NOT_CONFIGURED')
    expect(connectionHealthCodeOf({ message: 'fetch failed' })).toBe('CONNECTION_CHECK_FAILED')
  })
  it('健康结论：授权失效与配置缺失是异常（会拦写入）；限流、暂时不可用、这次调用缺角色只是受限', () => {
    expect(healthStatusOfCode(null)).toBe('HEALTHY')
    for (const code of ['AUTH_EXPIRED', 'SLR_NOT_US', 'LWA_CONFIG_MISSING', 'REFRESH_TOKEN_NOT_CONFIGURED', 'CONNECTION_CHECK_FAILED']) expect(healthStatusOfCode(code), code).toBe('UNHEALTHY')
    for (const code of ['THROTTLE_EXHAUSTED', 'UPSTREAM_ERROR', 'ROLE_MISSING']) expect(healthStatusOfCode(code), code).toBe('DEGRADED')
    expect(healthStatusOf('HEALTHY')).toBe('HEALTHY')
    expect(healthStatusOf('FAILED')).toBe('UNKNOWN')
    expect(healthStatusOf(null)).toBe('UNKNOWN')
  })
})

describe('动作规则', () => {
  it('已授权有令牌：三个动作都可以', () => {
    const states = connectionActionStates({ state: 'AUTHORIZED', hasToken: true }, null)
    expect(Object.values(states).every(item => item.allowed)).toBe(true)
  })
  it('已断开：只能重新授权', () => {
    const states = connectionActionStates({ state: 'REVOKED', hasToken: false }, null)
    expect(states.reauthorize.allowed).toBe(true)
    expect(states.healthCheck).toMatchObject({ allowed: false, reason: expect.stringContaining('重新授权') })
    expect(states.disconnect).toMatchObject({ allowed: false })
  })
  it('授权未完成或没有令牌：不能做健康检查', () => {
    expect(connectionActionStates({ state: 'AUTHORIZING', hasToken: false }, null).healthCheck.allowed).toBe(false)
    expect(connectionActionStates({ state: 'AUTHORIZED', hasToken: false }, null).healthCheck.allowed).toBe(false)
  })
  it('调用者受限（没有权限或店铺不在范围内）：全部不可用并说明原因', () => {
    const states = connectionActionStates({ state: 'AUTHORIZED', hasToken: true }, '没有权限')
    for (const item of Object.values(states)) expect(item).toEqual({ allowed: false, reason: '没有权限' })
  })
  it('断开要再次验证身份：步骤验证动作已登记；错误码已登记', () => {
    expect(Object.keys(STEP_UP_ACTIONS)).toContain(CONNECTION_DISCONNECT_STEP_UP)
    expect(ERROR_CODES.CONNECTION_ALREADY_DISCONNECTED.status).toBe(409)
    expect(ERROR_CODES.OAUTH_SELLER_MISMATCH.status).toBe(409)
    expect(Object.values(CONNECTION_ACTIONS).every(action => /^[A-Z_]+$/.test(action))).toBe(true)
  })
})

describe('报告权限与品牌分析资格', () => {
  const row = (sourceKey: string, over: Record<string, unknown> = {}) => ({ sellerAccountId: 's1', sourceKey, status: 'NORMAL', lastSuccessAt: NOW, lastErrorCode: null, ...over })

  it('每个来源各算一项：成功与缺失并存是部分具备，取最近的成功时间与失败码', () => {
    const result = derivedEvidenceOf(['a', 'b', 'c'], [row('a'), row('b', { status: 'UNAUTHORIZED', lastErrorCode: 'ROLE_MISSING', lastSuccessAt: null })])
    expect(result).toMatchObject({ state: 'PARTIAL', total: 3, failureCode: 'ROLE_MISSING', counts: { ok: 1, missing: 1, unverified: 1 } })
    expect(result.lastSuccessAt?.toISOString()).toBe(NOW.toISOString())
  })
  it('全部缺失：缺少角色；全部不适用：不适用；没有记录：尚未验证', () => {
    expect(derivedEvidenceOf(['a'], [row('a', { status: 'UNAUTHORIZED', lastErrorCode: 'DK_NO_BRAND', lastSuccessAt: null })]).state).toBe('MISSING')
    expect(derivedEvidenceOf(['a'], [row('a', { status: 'FAILED', lastErrorCode: 'BA_NO_BRAND', lastSuccessAt: null })]).state).toBe('NOT_APPLICABLE')
    expect(derivedEvidenceOf(['a', 'b'], []).state).toBe('UNVERIFIED')
  })
})
