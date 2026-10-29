import type { ReactNode } from 'react'
import { Alert, Button, Space, Tag, Tooltip } from 'antd'
import type { StepAction, StepInfo } from './onboarding-types'

// 步骤面板外框（P1-19）：步骤说明、前置条件、状态，以及统一的“保存草稿 / 完成此步 / 跳过”按钮。
// 前置条件不满足时“完成此步”禁用并写明原因；必填步骤不显示“跳过”。

export type StepFrameProps = {
  step: StepInfo
  busy: boolean
  children?: ReactNode
  /** 点击“完成此步”前是否还需要表单校验：由表单步骤自己提交，这里只负责按钮 */
  onComplete: () => void
  onSave?: () => void
  onSkip?: (action: StepAction) => void
  completeText?: string
}

const STATE_TAG = { PENDING: ['待完成', 'gold'], COMPLETED: ['已完成', 'green'], SKIPPED: ['已跳过', 'default'] } as const

export function StepFrame({ step, busy, children, onComplete, onSave, onSkip, completeText = '完成此步' }: StepFrameProps) {
  const done = step.state === 'COMPLETED'
  const blocked = !step.prerequisite.met ? (step.prerequisite.message ?? '前置条件尚未满足') : null
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <b style={{ fontSize: 16 }}>
          第 {step.no} 步：{step.title}
        </b>
        <Tag color={STATE_TAG[step.state][1]}>{STATE_TAG[step.state][0]}</Tag>
        <Tag bordered={false}>{step.required ? '必填' : '选填'}</Tag>
      </div>
      <p style={{ color: 'var(--ant-color-text-secondary)', marginTop: 0 }}>{step.hint}</p>
      {blocked ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={blocked} /> : null}
      {done ? <Alert type="success" showIcon style={{ marginBottom: 12 }} message="这一步已完成。向导结束后，可到对应的设置页面继续修改。" /> : null}
      <div style={{ marginBottom: 16 }}>{children}</div>
      {done ? null : (
        <Space>
          <Tooltip title={blocked}>
            <span>
              <Button type="primary" onClick={onComplete} loading={busy} disabled={Boolean(blocked)}>
                {completeText}
              </Button>
            </span>
          </Tooltip>
          {onSave ? (
            <Button onClick={onSave} disabled={busy}>
              保存草稿
            </Button>
          ) : null}
          {!step.required && onSkip ? (
            <Button onClick={() => onSkip('SKIP')} disabled={busy}>
              跳过此步
            </Button>
          ) : null}
        </Space>
      )}
    </div>
  )
}
