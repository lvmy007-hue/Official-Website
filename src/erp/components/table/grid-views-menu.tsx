import { useState, type ReactNode } from 'react'
import { App, Button, Checkbox, Dropdown, Input, Popover, Space, Switch, Tag, Tooltip, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { GRID_VIEW_NAME_MAX, type GridViewItem, type GridViewScope } from '@nova/api-contracts'
import { describeError } from '../../query/errors'
import { invalidNotice } from './grid-view-layout'
import type { GridViewsApi } from './use-grid-views'

// 表格工具栏里的“视图”区（P6-03）：切换视图、另存为、保存修改、设为默认、删除，以及“有未保存的修改”“有 N 个条件已失效”“视图暂时不可用”提示。
// 三个动作的权限：另存为个人视图是基础能力；共享给团队、设置团队默认、修改或删除团队视图需要 grid.view.share（没有时不显示共享开关，改团队视图的入口置灰并写明原因）。

const SCOPE_LABEL: Record<GridViewScope, string> = { USER: '我的', TEAM: '团队', SYSTEM: '系统' }
const DEFAULT_KEY = '__default'

function groupItems(items: GridViewItem[]): NonNullable<MenuProps['items']> {
  const out: NonNullable<MenuProps['items']> = [{ key: DEFAULT_KEY, label: '页面默认' }]
  for (const scope of ['USER', 'TEAM', 'SYSTEM'] as const) {
    const children = items.filter(item => item.scope === scope).map(item => ({ key: item.id, label: item.isDefault ? `${item.name}（默认）` : item.name }))
    if (children.length) out.push({ type: 'group', key: `group-${scope}`, label: SCOPE_LABEL[scope], children })
  }
  return out
}

function SaveAs({ views, run }: { views: GridViewsApi; run: (action: () => Promise<unknown>, ok: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [asDefault, setAsDefault] = useState(false)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    setSaving(true)
    const done = await run(() => views.saveAs({ name: name.trim(), scope: shared ? 'TEAM' : 'USER', isDefault: asDefault }), shared ? '已保存并共享给团队' : '已另存为我的视图')
    setSaving(false)
    if (done) {
      setOpen(false)
      setName('')
      setShared(false)
      setAsDefault(false)
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      title="另存为视图"
      content={
        <Space direction="vertical" size={8} style={{ width: 260 }}>
          <Input
            aria-label="视图名称"
            placeholder="视图名称"
            maxLength={GRID_VIEW_NAME_MAX}
            value={name}
            onChange={event => setName(event.target.value)}
            onPressEnter={() => name.trim() && void submit()}
          />
          {views.canShare ? (
            <Space>
              <Switch aria-label="共享给团队" size="small" checked={shared} onChange={setShared} />
              <span>共享给团队</span>
            </Space>
          ) : null}
          <Checkbox checked={asDefault} onChange={event => setAsDefault(event.target.checked)}>
            {shared ? '设为团队默认视图' : '设为我的默认视图'}
          </Checkbox>
          <Typography.Text type="secondary">
            保存当前的列显示、顺序、列宽、固定、排序与筛选。每个表格最多 {views.limits.user} 个个人视图{views.canShare ? `、${views.limits.team} 个团队视图` : ''}。
          </Typography.Text>
          <Button type="primary" block loading={saving} disabled={!name.trim()} onClick={() => void submit()}>
            保存
          </Button>
        </Space>
      }
    >
      <Button>另存为</Button>
    </Popover>
  )
}

/** 当前视图不能改时的原因；能改返回 null。 */
function readOnlyReason(active: GridViewItem | null): string | null {
  if (!active) return '正在使用页面默认列，请先“另存为”自己的视图'
  if (active.canEdit) return null
  return active.scope === 'SYSTEM' ? '系统视图只读，可以“另存为”自己的视图' : '修改团队视图需要“共享表格视图”权限（grid.view.share）'
}

export function GridViewsMenu({ views }: { views: GridViewsApi }): ReactNode {
  const { message, modal } = App.useApp()
  const run = async (action: () => Promise<unknown>, ok: string): Promise<boolean> => {
    try {
      await action()
      void message.success(ok)
      return true
    } catch (error) {
      // 版本冲突、重名、超出上限、缺少共享权限：服务端的提示已经写明原因与权限点，原样显示
      void message.error(describeError(error).message)
      return false
    }
  }
  const { active } = views
  const reason = readOnlyReason(active)
  const manage: MenuProps['items'] = [
    { key: 'default', label: '设为默认视图', disabled: !active || reason !== null || active.isDefault },
    { key: 'delete', label: '删除视图', danger: true, disabled: !active || reason !== null },
  ]
  const confirmDelete = (item: GridViewItem) =>
    modal.confirm({
      title: `删除视图“${item.name}”？`,
      content: '删除后无法恢复；正在使用它的人会回到页面默认列。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => run(() => views.remove(item), '视图已删除').then(() => undefined),
    })

  if (views.status === 'error') {
    return (
      <Space size={4}>
        <Typography.Text type="warning">视图暂时不可用，本次的列设置不会保存</Typography.Text>
        <Button type="link" size="small" onClick={views.retry}>
          重试
        </Button>
      </Space>
    )
  }
  return (
    <Space size={8} wrap>
      {views.invalid > 0 ? <Typography.Text type="warning">{invalidNotice(views.invalid)}</Typography.Text> : null}
      {views.dirty ? (
        <Tag color="warning" bordered={false}>
          有未保存的修改
        </Tag>
      ) : null}
      <Dropdown
        trigger={['click']}
        menu={{ selectedKeys: [active?.id ?? DEFAULT_KEY], items: groupItems(views.items), onClick: ({ key }) => views.apply(key === DEFAULT_KEY ? null : key) }}
        disabled={views.status === 'loading'}
      >
        <Button>视图：{active?.name ?? '页面默认'}</Button>
      </Dropdown>
      <SaveAs views={views} run={run} />
      <Tooltip title={reason ?? (views.dirty ? undefined : '没有需要保存的修改')}>
        <span>
          <Button disabled={reason !== null || !views.dirty} onClick={() => void run(() => views.overwrite(), '视图已保存')}>
            保存修改
          </Button>
        </span>
      </Tooltip>
      <Tooltip title={reason ?? undefined}>
        <span>
          <Dropdown
            trigger={['click']}
            menu={{
              items: manage,
              onClick: ({ key }) => {
                if (!active) return
                if (key === 'default') void run(() => views.makeDefault(active), '已设为默认视图')
                else confirmDelete(active)
              },
            }}
          >
            <Button aria-label="管理当前视图">管理</Button>
          </Dropdown>
        </span>
      </Tooltip>
    </Space>
  )
}
