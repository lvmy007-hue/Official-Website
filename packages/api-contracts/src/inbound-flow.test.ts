import { describe, expect, it } from 'vitest'
import { INBOUND_ACTIONS, INBOUND_STAGES, inboundPlanActions, inboundStageIndex, type InboundStage } from './inbound.js'
import { INBOUND_FLOW_STEPS, INBOUND_STEP_ACTIONS, inboundFlowSteps } from './inbound-flow.js'

const NOW = new Date('2026-12-12T08:00:00Z')
const flow = (stage: InboundStage, over: { pendingOp?: string | null; voidDeadlineAt?: string | null; lastErrorMessage?: string | null } = {}) =>
  inboundFlowSteps({ stage, pendingOp: null, voidDeadlineAt: null, ...over }, NOW)
const states = (stage: InboundStage, over = {}) => flow(stage, over).map(step => step.state)

describe('入仓计划流程骨架（P6-10）', () => {
  it('五步固定顺序：选品、装箱、分仓、运输、标签与发货', () => {
    expect(flow('DRAFT').map(step => step.label)).toEqual(['选品', '装箱', '分仓', '运输', '标签与发货'])
    expect(flow('DRAFT').map(step => step.key)).toEqual([...INBOUND_FLOW_STEPS])
  })

  it('每个阶段只会有一个“进行中”的步骤，且它之前的都已完成、之后的都未开始（已发货及以后全部完成）', () => {
    for (const stage of INBOUND_STAGES) {
      const result = states(stage)
      if (stage === 'CANCELLED') {
        expect(result).toEqual(Array(5).fill('NOT_STARTED'))
        continue
      }
      const current = result.indexOf('IN_PROGRESS')
      if (inboundStageIndex(stage) >= inboundStageIndex('SHIPPED')) expect(result).toEqual(Array(5).fill('DONE'))
      else {
        expect(current, stage).toBeGreaterThanOrEqual(0)
        expect(
          result.slice(0, current).every(state => state === 'DONE'),
          stage,
        ).toBe(true)
        expect(
          result.slice(current + 1).every(state => state === 'NOT_STARTED'),
          stage,
        ).toBe(true)
      }
    }
  })

  it('按钮分步：每个动作只属于一步，取消计划不属于任何一步；按钮可用性与 inboundPlanActions 完全一致', () => {
    const owned = Object.values(INBOUND_STEP_ACTIONS).flat()
    expect(new Set(owned).size).toBe(owned.length)
    expect([...owned, 'CANCEL'].sort()).toEqual([...INBOUND_ACTIONS].sort())
    for (const stage of INBOUND_STAGES) {
      const rules = inboundPlanActions({ stage, pendingOp: null, voidDeadlineAt: null }, NOW)
      for (const step of flow(stage)) for (const action of step.actions) expect({ allowed: action.allowed, reason: action.reason }, `${stage}.${action.action}`).toEqual(rules[action.action])
    }
  })

  it('不能点的按钮一定有原因，能点的没有原因', () => {
    for (const stage of INBOUND_STAGES)
      for (const step of flow(stage)) for (const action of step.actions) expect(action.allowed ? action.reason === null : typeof action.reason === 'string' && action.reason.length > 0).toBe(true)
  })

  it('装箱步骤：装箱方案已确认才能保存草稿与提交箱内物品', () => {
    const allowed = (stage: InboundStage) =>
      flow(stage)[1]!
        .actions.filter(action => action.allowed)
        .map(action => action.action)
    expect(allowed('CREATED')).toEqual(['GENERATE_PACKING', 'CONFIRM_PACKING'])
    expect(allowed('PACKING_CONFIRMED')).toEqual(['SAVE_BOXES', 'SUBMIT_PACKING_INFO'])
    expect(allowed('PACKING_INFO_SUBMITTED')).toEqual([])
  })

  it('有在途操作：所属步骤写“亚马逊正在处理”，所有按钮禁用；步骤已完成时保持已完成', () => {
    const busy = flow('PACKING_INFO_SUBMITTED', { pendingOp: 'GENERATE_PLACEMENT' })
    expect(busy[2]).toMatchObject({ state: 'IN_PROGRESS' })
    expect(busy[2]!.note).toContain('亚马逊正在处理：生成分仓方案')
    expect(busy.flatMap(step => step.actions).every(action => !action.allowed)).toBe(true)
    const tracking = flow('SHIPPED', { pendingOp: 'UPDATE_TRACKING' })
    expect(tracking[4]).toMatchObject({ state: 'DONE' })
    expect(tracking[4]!.note).toContain('回填追踪号')
    // 取消不属于任何一步：落在当前步骤
    expect(flow('CREATED', { pendingOp: 'CANCEL_PLAN' })[1]!.note).toContain('取消入仓计划')
  })

  it('上一次操作失败：当前步骤标出错并带原因；有在途操作或计划已结束时不标', () => {
    const failed = flow('PLACEMENT_CONFIRMED', { lastErrorMessage: '运输询价失败' })
    expect(failed.map(step => step.state)).toEqual(['DONE', 'DONE', 'DONE', 'ERROR', 'NOT_STARTED'])
    expect(failed[3]!.note).toBe('运输询价失败')
    expect(states('SHIPPED', { lastErrorMessage: '旧错误' })).toEqual(Array(5).fill('DONE'))
    expect(states('COMPLETED', { lastErrorMessage: '旧错误' })).toEqual(Array(5).fill('DONE'))
    expect(states('CANCELLED', { lastErrorMessage: '旧错误' })).toEqual(Array(5).fill('NOT_STARTED'))
    expect(flow('CREATED', { pendingOp: 'GENERATE_PACKING', lastErrorMessage: '旧错误' })[1]!.state).toBe('IN_PROGRESS')
  })

  it('已取消的计划：各步未开始，说明计划已取消，按钮全部禁用', () => {
    const cancelled = flow('CANCELLED')
    expect(cancelled.every(step => step.note === '计划已取消')).toBe(true)
    expect(cancelled.flatMap(step => step.actions).every(action => !action.allowed && action.reason === '计划已取消')).toBe(true)
  })
})
