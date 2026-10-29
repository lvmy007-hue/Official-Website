import { Alert, Steps, Typography } from 'antd'
import type { InboundFlowState, InboundFlowStepView } from '@nova/api-contracts'

// 入仓计划的五步流程（P6-10，16 章第 5.1 节）：选品、装箱、分仓、运输、标签与发货。
// 每一步的状态与可点的操作都由服务端按计划状态算出（overview.steps）；前端只展示，不自己判断能不能点，
// 不能点的操作写明原因。点步骤条切到这一步对应的页签。

const STEP_STATUS: Record<InboundFlowState, 'wait' | 'process' | 'finish' | 'error'> = { NOT_STARTED: 'wait', IN_PROGRESS: 'process', DONE: 'finish', ERROR: 'error' }

/** 默认选中的步骤：出错的先看；其次是进行中的；全部完成停在最后一步；全部未开始（已取消）停在第一步。 */
export function defaultStepIndex(steps: readonly InboundFlowStepView[]): number {
  const error = steps.findIndex(step => step.state === 'ERROR')
  if (error >= 0) return error
  const current = steps.findIndex(step => step.state === 'IN_PROGRESS')
  if (current >= 0) return current
  const done = steps.map(step => step.state).lastIndexOf('DONE')
  return done >= 0 ? done : 0
}

export function FlowSteps({ steps, selected, onSelect }: { steps: readonly InboundFlowStepView[]; selected: number; onSelect: (index: number) => void }) {
  return (
    <Steps
      size="small"
      responsive={false}
      current={selected}
      onChange={onSelect}
      items={steps.map(step => ({ title: step.label, description: step.stateLabel, status: STEP_STATUS[step.state] }))}
      style={{ overflowX: 'auto' }}
      data-testid="flow-steps"
    />
  )
}

/** 选中步骤的说明与操作清单：能做的操作在这一步的页签里或页面右上角；不能做的写明原因。 */
export function StepPanel({ step }: { step: InboundFlowStepView }) {
  const allowed = step.actions.filter(action => action.allowed)
  const blocked = step.actions.filter(action => !action.allowed)
  const type = step.state === 'ERROR' ? 'error' : step.state === 'DONE' ? 'success' : 'info'
  return (
    <Alert
      type={type}
      showIcon
      data-testid="step-panel"
      message={`${step.label}：${step.stateLabel}`}
      description={
        <div>
          {step.note ? <div>{step.note}</div> : null}
          {allowed.length > 0 ? <div data-testid="step-allowed">现在可以做：{allowed.map(action => action.label).join('、')}</div> : null}
          {blocked.length > 0 ? (
            <ul data-testid="step-blocked" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {blocked.map(action => (
                <li key={action.action}>
                  <Typography.Text type="secondary">
                    {action.label}：不能做，{action.reason}
                  </Typography.Text>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      }
    />
  )
}
