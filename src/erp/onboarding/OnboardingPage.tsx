import { useState } from 'react'
import { Alert, Button, Card, Modal, Result, Steps, Typography } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../api'
import { DataState } from '../components/data-state/DataState'
import { stateFromError } from '../components/data-state/from-error'
import { PageHeader } from '../components/page/PageHeader'
import { formatDateTime } from '../format'
import { AppLink } from '../nav/AppLink'
import { apiQueryKey, useApiQuery } from '../query/api-query'
import { describeError } from '../query/errors'
import { ME_QUERY_KEY } from '../session/session'
import { FxCostStep, ProfileStep, SyncScopeStep } from './FormSteps'
import { LinkStep, WriteSwitchesStep } from './LinkSteps'
import { MembersStep } from './MembersStep'
import type { InvitationResult, OnboardingView, StepAction, StepInfo, StepPanelProps } from './onboarding-types'

// 初始化向导（P1-19，/app/onboarding）：8 步，进度保存在服务端，随时可以离开、回来继续。
// 必填步骤完成、选填步骤完成或跳过后，向导结束并自动启动首次同步（历史回补分段、由近及远）。

const PANELS: Record<StepInfo['key'], (props: StepPanelProps) => JSX.Element> = {
  PROFILE: ProfileStep,
  ENTITIES: LinkStep,
  SELLER_AUTH: LinkStep,
  ADS_AUTH: LinkStep,
  SYNC_SCOPE: SyncScopeStep,
  FX_COST: FxCostStep,
  MEMBERS: MembersStep,
  WRITE_SWITCHES: WriteSwitchesStep,
}
const ANT_STATUS = { PENDING: 'wait', COMPLETED: 'finish', SKIPPED: 'finish' } as const
const QUERY_PATH = '/onboarding'

export default function OnboardingPage() {
  const client = useQueryClient()
  const query = useApiQuery<OnboardingView>({ domain: 'config', path: QUERY_PATH, scoped: false, staleMs: 0 })
  const [selected, setSelected] = useState<StepInfo['key'] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [invitations, setInvitations] = useState<InvitationResult[]>([])

  if (query.isError) return <DataState {...stateFromError(describeError(query.error), { permission: 'settings.write', onRetry: () => void query.refetch() })} />
  if (!query.data) return <DataState kind="skeleton" />
  const view = query.data

  if (view.completed) {
    return (
      <Result
        status="success"
        title="企业初始化已完成"
        subTitle={
          view.firstSync
            ? `首次同步已于 ${formatDateTime(view.firstSync.startedAt)} 启动：${view.firstSync.jobs} 个任务，历史回补共 ${view.firstSync.segments} 段（由近及远，最近的数据最先出现）。数据陆续到位前，页面会如实显示“暂无数据 / 同步中”。`
            : '没有需要初始化的内容。'
        }
        extra={
          <AppLink to="/app/overview" keepScope={false}>
            <Button type="primary">进入经营控制台</Button>
          </AppLink>
        }
      />
    )
  }

  const currentKey = selected ?? (view.currentStep === 'DONE' ? view.steps[0].key : view.currentStep)
  const step = view.steps.find(item => item.key === currentKey) ?? view.steps[0]
  const Panel = PANELS[step.key]

  const submit = async (action: StepAction, data?: unknown) => {
    setBusy(true)
    setError(null)
    try {
      const result = await apiFetch<OnboardingView>(QUERY_PATH, { method: 'PATCH', body: JSON.stringify({ step: step.key, action, data, version: view.version }) })
      client.setQueryData(apiQueryKey('config', QUERY_PATH), result)
      setWarnings(result.warnings ?? [])
      setInvitations(result.invitations ?? [])
      setSelected(null)
      if (result.completed) await client.invalidateQueries({ queryKey: ME_QUERY_KEY })
    } catch (failure) {
      const info = describeError(failure)
      setError({ message: info.message, requestId: info.requestId })
      // 版本冲突：别人刚改过，重新取最新进度
      if (info.kind === 'conflict') void query.refetch()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader title="企业初始化" description="完成 8 步设置后，系统会自动开始首次同步。进度会保存，可以随时离开再回来。" />
      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16, marginTop: 8 }}>
        <Card size="small">
          <Steps
            direction="vertical"
            size="small"
            current={view.steps.findIndex(item => item.key === step.key)}
            onChange={index => setSelected(view.steps[index].key)}
            items={view.steps.map(item => ({ title: item.title, status: ANT_STATUS[item.state], description: item.state === 'SKIPPED' ? '已跳过' : item.required ? '必填' : '选填' }))}
          />
        </Card>
        <Card size="small">
          {error ? (
            <Alert
              type="error"
              showIcon
              closable
              style={{ marginBottom: 12 }}
              message={error.message}
              description={error.requestId ? `请求编号：${error.requestId}` : undefined}
              onClose={() => setError(null)}
            />
          ) : null}
          {warnings.map(text => (
            <Alert key={text} type="warning" showIcon style={{ marginBottom: 12 }} message={text} />
          ))}
          <Panel key={step.key} step={step} view={view} busy={busy} onSubmit={(action, data) => void submit(action, data)} />
        </Card>
      </div>
      <Modal
        open={invitations.length > 0}
        title="成员邀请已生成"
        onCancel={() => setInvitations([])}
        footer={
          <Button type="primary" onClick={() => setInvitations([])}>
            我已保存，关闭
          </Button>
        }
        maskClosable={false}
        destroyOnClose
      >
        {invitations.map(item => (
          <div key={item.email} style={{ marginBottom: 12 }}>
            <b>{item.email}</b>
            {item.emailed ? (
              <div style={{ color: 'var(--ant-color-success)' }}>邀请邮件已发送，72 小时内有效。</div>
            ) : (
              <>
                <Alert type="warning" showIcon style={{ margin: '4px 0' }} message="邮件通道尚未配置，请复制链接并通过安全渠道交给本人；链接只显示这一次，72 小时有效、只能使用一次。" />
                <Typography.Paragraph copyable={{ text: item.link ?? '' }} code style={{ wordBreak: 'break-all', marginBottom: 0 }}>
                  {item.link}
                </Typography.Paragraph>
              </>
            )}
          </div>
        ))}
      </Modal>
    </div>
  )
}
