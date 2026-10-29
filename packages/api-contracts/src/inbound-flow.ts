import { INBOUND_OP_LABEL, inboundPlanActions, inboundStageIndex, isInboundStage, type InboundAction, type InboundOp, type InboundPlanState, type InboundStage } from './inbound.js'

// 入仓计划的流程骨架（P6-10，15 章 5.4、16 章 5.1）：选品、装箱、分仓、运输、标签与发货五步。
// 每一步的状态与可用按钮都由这里的纯函数按“计划阶段、在途操作、上一次失败”算出，服务端写进 `GET /inbound/plans/:id` 的 `steps`，
// 前端只负责显示，不自己判断“能不能点、为什么不能点”（按钮的可用性沿用 `inboundPlanActions`，与服务端校验同一份规则）。
// 本文件不带 zod：前端与服务端共用。

export const INBOUND_FLOW_STEPS = ['ITEMS', 'BOXES', 'PLACEMENT', 'TRANSPORT', 'LABELS_SHIP'] as const
export type InboundFlowStepKey = (typeof INBOUND_FLOW_STEPS)[number]
export const INBOUND_FLOW_LABEL: Record<InboundFlowStepKey, string> = { ITEMS: '选品', BOXES: '装箱', PLACEMENT: '分仓', TRANSPORT: '运输', LABELS_SHIP: '标签与发货' }

export const INBOUND_FLOW_STATES = ['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'ERROR'] as const
export type InboundFlowState = (typeof INBOUND_FLOW_STATES)[number]
export const INBOUND_FLOW_STATE_LABEL: Record<InboundFlowState, string> = { NOT_STARTED: '未开始', IN_PROGRESS: '进行中', DONE: '已完成', ERROR: '出错' }

export const INBOUND_ACTION_LABEL: Record<InboundAction, string> = {
  ELIGIBILITY: '资格预检',
  SUBMIT: '提交创建',
  GENERATE_PACKING: '生成装箱方案',
  CONFIRM_PACKING: '确认装箱方案',
  SAVE_BOXES: '保存装箱草稿',
  SUBMIT_PACKING_INFO: '提交箱内物品',
  GENERATE_PLACEMENT: '生成分仓方案',
  CONFIRM_PLACEMENT: '确认分仓方案',
  GENERATE_TRANSPORT: '生成运输方案',
  GENERATE_WINDOWS: '生成送达时间窗',
  CONFIRM_WINDOW: '确认送达时间窗',
  CONFIRM_TRANSPORT: '确认运输方案',
  PRINT_LABELS: '批量打印标签',
  MARK_SHIPPED: '标记已发货',
  UPDATE_TRACKING: '回填追踪号',
  CANCEL: '取消计划',
}

/** 每一步里有哪些动作；取消计划不属于任何一步，在页面头部单独给。 */
export const INBOUND_STEP_ACTIONS: Record<InboundFlowStepKey, readonly InboundAction[]> = {
  ITEMS: ['ELIGIBILITY', 'SUBMIT'],
  BOXES: ['GENERATE_PACKING', 'CONFIRM_PACKING', 'SAVE_BOXES', 'SUBMIT_PACKING_INFO'],
  PLACEMENT: ['GENERATE_PLACEMENT', 'CONFIRM_PLACEMENT'],
  TRANSPORT: ['GENERATE_TRANSPORT', 'GENERATE_WINDOWS', 'CONFIRM_WINDOW', 'CONFIRM_TRANSPORT'],
  LABELS_SHIP: ['PRINT_LABELS', 'MARK_SHIPPED', 'UPDATE_TRACKING'],
}

/** 一步从哪个阶段开始（含）、到哪个阶段算完成（含之后所有阶段）。 */
const STEP_RANGE: Record<InboundFlowStepKey, { start: InboundStage; done: InboundStage }> = {
  ITEMS: { start: 'DRAFT', done: 'CREATED' },
  BOXES: { start: 'CREATED', done: 'PACKING_INFO_SUBMITTED' },
  PLACEMENT: { start: 'PACKING_INFO_SUBMITTED', done: 'PLACEMENT_CONFIRMED' },
  TRANSPORT: { start: 'PLACEMENT_CONFIRMED', done: 'TRANSPORT_CONFIRMED' },
  LABELS_SHIP: { start: 'TRANSPORT_CONFIRMED', done: 'SHIPPED' },
}

/** 在途操作属于哪一步；取消计划不属于任何一步（落在当前步骤）。 */
const OP_STEP: Partial<Record<InboundOp, InboundFlowStepKey>> = {
  ELIGIBILITY: 'ITEMS',
  CREATE_PLAN: 'ITEMS',
  GENERATE_PACKING: 'BOXES',
  CONFIRM_PACKING: 'BOXES',
  SUBMIT_PACKING_INFO: 'BOXES',
  GENERATE_PLACEMENT: 'PLACEMENT',
  CONFIRM_PLACEMENT: 'PLACEMENT',
  GENERATE_TRANSPORT: 'TRANSPORT',
  CONFIRM_TRANSPORT: 'TRANSPORT',
  GENERATE_WINDOWS: 'TRANSPORT',
  CONFIRM_WINDOW: 'TRANSPORT',
  UPDATE_TRACKING: 'LABELS_SHIP',
  LABELS: 'LABELS_SHIP',
}

export interface InboundFlowAction {
  action: InboundAction
  label: string
  allowed: boolean
  /** 不能点时的原因；能点时为 null。 */
  reason: string | null
}
export interface InboundFlowStepView {
  key: InboundFlowStepKey
  label: string
  state: InboundFlowState
  stateLabel: string
  /** 在途操作、失败原因或取消说明；没有就是 null。 */
  note: string | null
  actions: InboundFlowAction[]
}
export interface InboundFlowInput extends InboundPlanState {
  lastErrorMessage?: string | null
}

/**
 * 算五步的状态与按钮。
 * - 阶段落在某一步的“开始到完成”之间是进行中，到了完成阶段之后是已完成，还没到开始阶段是未开始；已取消的计划各步都是未开始；
 * - 有在途操作：该操作所属的一步显示“亚马逊正在处理”（那一步已完成时保持已完成，只加说明）；
 * - 上一次操作失败（没有在途操作、计划没有结束）：当前这一步（第一个没完成的）标“出错”并写原因——失败的操作不单独记录属于哪一步，
 *   而失败总是发生在当前步骤的操作上，所以归到当前步骤；
 * - 按钮可用性直接取 `inboundPlanActions`，不另造规则。
 */
export function inboundFlowSteps(plan: InboundFlowInput, now: Date = new Date()): InboundFlowStepView[] {
  const stage: InboundStage = isInboundStage(plan.stage) ? plan.stage : 'DRAFT'
  const actions = inboundPlanActions({ stage, pendingOp: plan.pendingOp, voidDeadlineAt: plan.voidDeadlineAt }, now)
  const cancelled = stage === 'CANCELLED'
  const index = inboundStageIndex(stage)
  const stateOf = (key: InboundFlowStepKey): InboundFlowState => {
    if (cancelled) return 'NOT_STARTED'
    const range = STEP_RANGE[key]
    if (index >= inboundStageIndex(range.done)) return 'DONE'
    return index >= inboundStageIndex(range.start) ? 'IN_PROGRESS' : 'NOT_STARTED'
  }
  const states = new Map(INBOUND_FLOW_STEPS.map(key => [key, stateOf(key)]))
  const current = cancelled ? null : (INBOUND_FLOW_STEPS.find(key => states.get(key) !== 'DONE') ?? null)
  const pendingOp = plan.pendingOp as InboundOp | null
  const pendingStep = pendingOp ? (OP_STEP[pendingOp] ?? current) : null
  const notes = new Map<InboundFlowStepKey, string>()
  if (cancelled) for (const key of INBOUND_FLOW_STEPS) notes.set(key, '计划已取消')
  if (pendingOp && pendingStep) {
    notes.set(pendingStep, `亚马逊正在处理：${INBOUND_OP_LABEL[pendingOp] ?? pendingOp}，完成前不能做其他操作`)
    if (states.get(pendingStep) === 'NOT_STARTED') states.set(pendingStep, 'IN_PROGRESS')
  } else if (plan.lastErrorMessage && current) {
    states.set(current, 'ERROR')
    notes.set(current, plan.lastErrorMessage)
  }
  return INBOUND_FLOW_STEPS.map(key => {
    const state = states.get(key) ?? 'NOT_STARTED'
    return {
      key,
      label: INBOUND_FLOW_LABEL[key],
      state,
      stateLabel: INBOUND_FLOW_STATE_LABEL[state],
      note: notes.get(key) ?? null,
      actions: INBOUND_STEP_ACTIONS[key].map(action => ({ action, label: INBOUND_ACTION_LABEL[action], allowed: actions[action].allowed, reason: actions[action].reason })),
    }
  })
}
