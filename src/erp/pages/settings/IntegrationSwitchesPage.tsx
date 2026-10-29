import { useState } from 'react'
import { Alert, Popover, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { PageHeader, SimpleGrid, FormAction } from '../../components'
import { formatDateTime } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'

// 接口与写入开关（P1-28-1，09 章 9.13）：企业对亚马逊的每一类写入都有独立开关，默认全部关闭。
// - 开启必须逐项进行：前置条件满足（应用凭据、授权、写权限范围、连接健康）、填写原因、勾选确认、再次验证身份；
// - 关闭可以批量；“一键全部只读”用于紧急情况；任何变更都写入变更记录与审计，并通知管理员；
// - 连续失败 5 次或授权失效时系统会自动关闭；平台也可通过部署配置紧急强制关闭，页面如实显示原因。

type Check = { code: string; label: string; passed: boolean; hint?: string }
type History = { id: string; action: string; reason: string; actor: string; at: string }
export type SwitchItem = {
  key: string
  label: string
  group: string
  groupLabel: string
  enabled: boolean
  forcedOffReason: string | null
  enabledAt: string | null
  enabledBy: string | null
  reason: string | null
  autoDisabledReason: string | null
  calls7d: number
  failures7d: number
  consecutiveFailures: number
  prerequisites: Check[]
  canEnable: boolean
  history: History[]
}
export type SwitchOverview = { mode: 'READ_ONLY' | 'PARTIAL' | 'ALL'; enabledCount: number; total: number; statsDays: number; emergencyForced: boolean; items: SwitchItem[] }

const WRITE = 'settings.integration.write'
const PATH = '/settings/integrations'
const MODE_LABEL = { READ_ONLY: ['只读模式', 'default'], PARTIAL: ['部分可写', 'warning'], ALL: ['全部可写', 'success'] } as const
export const ACTION_LABEL: Record<string, string> = { ENABLED: '开启', DISABLED: '关闭', AUTO_DISABLED: '系统自动关闭', READONLY_ALL: '一键全部只读' }

/** 开关不能开启的原因（给按钮悬停与旁注用）。 */
export function enableBlockReason(item: SwitchItem): string | undefined {
  if (item.forcedOffReason) return item.forcedOffReason
  if (item.canEnable) return undefined
  const failed = item.prerequisites.filter(check => !check.passed)
  return `前置条件未满足：${failed.map(check => (check.hint ? `${check.label}（${check.hint}）` : check.label)).join('；')}`
}

function StatusTag({ item }: { item: SwitchItem }) {
  if (item.forcedOffReason) return <Tag color="error">平台强制关闭</Tag>
  if (item.enabled) return <Tag color="success">已开启</Tag>
  if (item.autoDisabledReason) return <Tag color="warning">已自动关闭</Tag>
  return <Tag>已关闭</Tag>
}

function HistoryCell({ item }: { item: SwitchItem }) {
  const last = item.history[0]
  if (!last) return <Typography.Text type="secondary">暂无变更</Typography.Text>
  const line = (entry: History) => `${formatDateTime(entry.at)} · ${ACTION_LABEL[entry.action] ?? entry.action} · ${entry.actor}`
  return (
    <Popover
      title="最近变更"
      content={
        <ul style={{ margin: 0, paddingLeft: 16, maxWidth: 360 }}>
          {item.history.map(entry => (
            <li key={entry.id}>
              {line(entry)}
              <div style={{ color: 'var(--ant-color-text-secondary)' }}>原因：{entry.reason}</div>
            </li>
          ))}
        </ul>
      }
    >
      <span style={{ cursor: 'pointer' }}>{line(last)}</span>
    </Popover>
  )
}

function PrerequisiteCell({ item }: { item: SwitchItem }) {
  const passed = item.prerequisites.filter(check => check.passed).length
  return (
    <Popover
      title="开启前置条件"
      content={
        <ul style={{ margin: 0, paddingLeft: 16, maxWidth: 360 }}>
          {item.prerequisites.map(check => (
            <li key={check.code} style={{ color: check.passed ? undefined : 'var(--ant-color-error)' }}>
              {check.passed ? '✓ ' : '✗ '}
              {check.label}
              {!check.passed && check.hint ? `：${check.hint}` : ''}
            </li>
          ))}
        </ul>
      }
    >
      <Tag color={passed === item.prerequisites.length ? 'success' : 'warning'} style={{ cursor: 'pointer' }}>
        {passed}/{item.prerequisites.length} 项满足
      </Tag>
    </Popover>
  )
}

export default function IntegrationSwitchesPage() {
  const query = useApiQuery<SwitchOverview>({ domain: 'config', path: PATH, scoped: false })
  const [selected, setSelectedKeys] = useState<string[]>([])
  const [gridNonce, setGridNonce] = useState(0)
  const setSelected = (keys: string[]) => {
    setSelectedKeys(keys)
    if (keys.length === 0) setGridNonce(value => value + 1)
  }
  // 失败提示由表单弹窗显示（silent），成功后让设置类缓存失效（顶栏的写入状态也随之刷新）
  const post = useApiMutation<{ path: string; body: unknown }, unknown>({ method: 'POST', path: v => v.path, body: v => v.body, invalidate: ['config'], silent: true })
  const patch = useApiMutation<unknown, unknown>({ method: 'PATCH', path: PATH, invalidate: ['config'], silent: true })
  const send = (path: string, body: unknown) => post.mutateAsync({ path, body })
  const overview = query.data

  const items = overview?.items ?? []
  const selectedEnabled = selected.filter(key => items.find(item => item.key === key)?.enabled)
  const columns: ColumnsType<SwitchItem> = [
    {
      title: '写入类别',
      key: 'label',
      render: (_, item) => (
        <div>
          <div>{item.label}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {item.groupLabel}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 150,
      render: (_, item) => (
        <div>
          <StatusTag item={item} />
          {item.forcedOffReason ? <div style={{ fontSize: 12, color: 'var(--ant-color-error)' }}>{item.forcedOffReason}</div> : null}
          {!item.enabled && item.autoDisabledReason ? <div style={{ fontSize: 12, color: 'var(--ant-color-warning)' }}>{item.autoDisabledReason}</div> : null}
          {item.enabled && item.enabledBy ? (
            <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>
              {item.enabledBy} 开启于 {formatDateTime(item.enabledAt)}
            </div>
          ) : null}
        </div>
      ),
    },
    { title: `近 ${overview?.statsDays ?? 7} 天调用 / 失败`, key: 'calls', width: 130, render: (_, item) => `${item.calls7d} / ${item.failures7d}` },
    { title: '连续失败', dataIndex: 'consecutiveFailures', width: 90 },
    { title: '前置条件', key: 'prereq', width: 120, render: (_, item) => <PrerequisiteCell item={item} /> },
    { title: '最近变更', key: 'history', render: (_, item) => <HistoryCell item={item} /> },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      fixed: 'right',
      render: (_, item) =>
        item.enabled ? (
          <FormAction
            label="关闭"
            guard={{ permission: WRITE }}
            title={`关闭写入：${item.label}`}
            description="关闭后，这一类改动只做预览与记录，不会再发送到亚马逊。"
            reason={{ label: '关闭原因' }}
            okText="关闭"
            onSubmit={values => send(`${PATH}/${encodeURIComponent(item.key)}/disable`, { reason: values.reason })}
            successText={`已关闭“${item.label}”`}
            buttonProps={{ size: 'small' }}
          />
        ) : (
          <FormAction
            label="开启"
            guard={{
              permission: WRITE,
              condition: { ok: enableBlockReason(item) === undefined, reason: enableBlockReason(item), fix: { label: '前往连接中心', href: '/app/connections', requires: 'connection.read' } },
            }}
            title={`开启写入：${item.label}`}
            description={<Alert type="warning" showIcon message="开启后，这一类改动经预览确认后会真实修改亚马逊店铺数据，所有操作都会记录审计。" />}
            reason={{ label: '开启原因', placeholder: '例如：本月起由运营在系统内统一调整价格' }}
            confirmText="我已了解：开启后该类写入会真实修改亚马逊店铺数据"
            stepUp="switch.enable"
            okText="开启"
            danger
            onSubmit={values => send(`${PATH}/${encodeURIComponent(item.key)}/enable`, { reason: values.reason, confirm: true })}
            successText={`已开启“${item.label}”`}
            buttonProps={{ size: 'small', type: 'primary' }}
          />
        ),
    },
  ]

  const actions = overview ? (
    <>
      <FormAction
        label={`批量关闭所选（${selectedEnabled.length}）`}
        guard={{ permission: WRITE, condition: { ok: selectedEnabled.length > 0, reason: '请先勾选已开启的开关' } }}
        title="批量关闭写入开关"
        description={`将关闭 ${selectedEnabled.length} 项写入开关；开启仍需逐项填写原因并确认。`}
        reason={{ label: '关闭原因' }}
        okText="批量关闭"
        onSubmit={values => patch.mutateAsync({ keys: selectedEnabled, enabled: false, reason: values.reason })}
        successText="已批量关闭"
        onDone={() => setSelected([])}
      />
      <FormAction
        label="一键全部只读"
        danger
        guard={{ permission: WRITE, condition: { ok: overview.enabledCount > 0, reason: '当前已经是全部只读' } }}
        title="一键全部只读"
        description="紧急情况使用：立即关闭企业全部写入开关，之后所有改动只做预览与记录。"
        reason={{ label: '原因' }}
        okText="全部只读"
        onSubmit={values => send(`${PATH}/readonly-all`, { reason: values.reason })}
        successText="已切换为全部只读"
        onDone={() => setSelected([])}
      />
    </>
  ) : null

  const [modeText, modeColor] = overview ? MODE_LABEL[overview.mode] : ['读取中', 'default']
  return (
    <div>
      <PageHeader title="接口与写入开关" description="控制系统是否可以向亚马逊写入。默认全部关闭；开启需要逐项确认，任何变更都会留痕并通知管理员。" actions={actions} />
      {overview ? (
        <Space style={{ margin: '8px 0 12px' }} wrap>
          <Tag color={modeColor}>{modeText}</Tag>
          <span>
            已开启 {overview.enabledCount} / {overview.total} 项
          </span>
        </Space>
      ) : null}
      {overview?.emergencyForced ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message="平台已通过部署配置紧急强制关闭写入：在平台解除之前，下列开关即使显示开启也不会生效。" /> : null}
      <SimpleGrid<SwitchItem>
        key={gridNonce}
        gridId="settings.integration-switches"
        columns={columns}
        rows={query.data?.items}
        rowKey={item => item.key}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '写入开关', prerequisite: '开关目录由系统提供，正常情况下不会为空；请刷新页面。' }}
        onSelectionChange={rows => setSelectedKeys(rows.map(item => item.key))}
      />
    </div>
  )
}
