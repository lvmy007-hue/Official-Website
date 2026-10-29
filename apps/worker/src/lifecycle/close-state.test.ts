import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLOSE_STEP_KEYS, parseCloseState } from './close-state'

// 后台任务不依赖契约包：直接读契约源码里的步骤清单，保证两边一致（顺序也一致）
const contractSource = readFileSync(resolve(__dirname, '../../../../packages/api-contracts/src/lifecycle.ts'), 'utf8')
const contractKeys = [...(contractSource.match(/export const CLOSE_STEPS = \[([\s\S]*?)\] as const/)?.[1] ?? '').matchAll(/key: '([A-Z_]+)'/g)].map(match => match[1])

describe('注销流程状态', () => {
  it('后台任务的步骤定义与契约包完全一致（顺序也一致）', () => {
    expect(contractKeys.length).toBeGreaterThan(0)
    expect([...CLOSE_STEP_KEYS]).toEqual(contractKeys)
  })

  it('保存的初始状态（全部待处理）能被后台任务原样读取', () => {
    const parsed = parseCloseState({ runs: 1, startedAt: '2026-01-01T00:00:00.000Z', requestedBy: 'platform-admin-1', steps: Object.fromEntries(contractKeys.map(key => [key, { state: 'PENDING' }])) })
    expect(parsed.requestedBy).toBe('platform-admin-1')
    expect(Object.keys(parsed.steps)).toEqual(contractKeys)
    expect(Object.values(parsed.steps).every(step => step.state === 'PENDING')).toBe(true)
  })

  it('保存的状态缺字段、含未知步骤状态时，补成“待处理”，不抛错', () => {
    const parsed = parseCloseState({ runs: 2, steps: { EXPORT: { state: 'DONE', finishedAt: '2026-01-01T00:00:00.000Z' }, PROOF: { state: 'BROKEN' } } }, 'actor')
    expect(parsed.runs).toBe(2)
    expect(parsed.requestedBy).toBe('actor')
    expect(parsed.steps.EXPORT.state).toBe('DONE')
    expect(parsed.steps.PROOF.state).toBe('PENDING')
    expect(parsed.steps.DELETE_DATA.state).toBe('PENDING')
  })

  it('完全没有保存状态时按第 1 轮处理', () => {
    expect(parseCloseState(null).runs).toBe(1)
    expect(parseCloseState('坏数据').runs).toBe(1)
  })
})
