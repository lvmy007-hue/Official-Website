import { useState, type ReactNode } from 'react'
import { App, Button, Dropdown, Input, Popover, Space, Switch, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { GRID_VIEW_NAME_MAX, type GridViewItem } from '@nova/api-contracts'
import { describeError } from '../../query/errors'
import { invalidNotice } from './grid-view-layout'
import type { FilterSchemesApi } from './use-filter-schemes'

// 工具栏里的“筛选方案”（P6-04）：套用、把当前筛选另存为方案（可共享给团队）、删除。
// 权限同视图：另存为个人方案是基础能力，共享给团队需要 grid.view.share（没有时不显示共享开关）。

const SCOPE_LABEL = { USER: '我的', TEAM: '团队', SYSTEM: '系统' } as const

function SaveScheme({ schemes, run }: { schemes: FilterSchemesApi; run: (action: () => Promise<unknown>, ok: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    setSaving(true)
    const done = await run(() => schemes.saveAs({ name: name.trim(), scope: shared ? 'TEAM' : 'USER' }), shared ? '筛选方案已保存并共享给团队' : '已保存为我的筛选方案')
    setSaving(false)
    if (done) {
      setOpen(false)
      setName('')
      setShared(false)
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      title="把当前筛选存为方案"
      content={
        <Space direction="vertical" size={8} style={{ width: 260 }}>
          <Input
            aria-label="方案名称"
            placeholder="方案名称"
            maxLength={GRID_VIEW_NAME_MAX}
            value={name}
            onChange={event => setName(event.target.value)}
            onPressEnter={() => name.trim() && void submit()}
          />
          {schemes.canShare ? (
            <Space>
              <Switch aria-label="筛选方案共享给团队" size="small" checked={shared} onChange={setShared} />
              <span>共享给团队</span>
            </Space>
          ) : null}
          <Typography.Text type="secondary">
            只保存筛选条件，不含列设置。每个表格最多 {schemes.limits.user} 个个人方案{schemes.canShare ? `、${schemes.limits.team} 个团队方案` : ''}。
          </Typography.Text>
          <Button type="primary" block loading={saving} disabled={!name.trim()} onClick={() => void submit()}>
            保存方案
          </Button>
        </Space>
      }
    >
      <Button disabled={!schemes.hasFilters} title={schemes.hasFilters ? undefined : '先设置筛选条件，再存为方案'} aria-label="存为筛选方案">
        存为方案
      </Button>
    </Popover>
  )
}

export function FilterSchemesMenu({ schemes }: { schemes: FilterSchemesApi }): ReactNode {
  const { message, modal } = App.useApp()
  const run = async (action: () => Promise<unknown>, ok: string): Promise<boolean> => {
    try {
      await action()
      void message.success(ok)
      return true
    } catch (error) {
      void message.error(describeError(error).message)
      return false
    }
  }
  const confirmDelete = (item: GridViewItem) =>
    modal.confirm({
      title: `删除筛选方案“${item.name}”？`,
      content: '删除后无法恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => run(() => schemes.remove(item), '筛选方案已删除').then(() => undefined),
    })

  if (schemes.status === 'error') {
    return (
      <Space size={4}>
        <Typography.Text type="warning">筛选方案暂时不可用</Typography.Text>
        <Button type="link" size="small" onClick={schemes.retry}>
          重试
        </Button>
      </Space>
    )
  }
  const groups: NonNullable<MenuProps['items']> = (['USER', 'TEAM', 'SYSTEM'] as const).flatMap(scope => {
    const children = schemes.items
      .filter(item => item.scope === scope)
      .map(item => ({
        key: item.id,
        label: (
          <span className="erp-scheme-item">
            <span>{item.name}</span>
            {item.canEdit ? (
              <Button
                type="link"
                size="small"
                danger
                aria-label={`删除筛选方案：${item.name}`}
                onClick={event => {
                  event.stopPropagation()
                  confirmDelete(item)
                }}
              >
                删除
              </Button>
            ) : null}
          </span>
        ),
      }))
    return children.length ? [{ type: 'group' as const, key: `scheme-${scope}`, label: SCOPE_LABEL[scope], children }] : []
  })
  const apply = (id: string) => {
    const item = schemes.items.find(entry => entry.id === id)
    if (!item) return
    const ignored = schemes.apply(item)
    if (ignored > 0) void message.warning(invalidNotice(ignored))
  }
  return (
    <Space size={8}>
      <Dropdown
        trigger={['click']}
        disabled={schemes.status === 'loading'}
        menu={{ items: groups.length ? groups : [{ key: 'empty', label: '还没有筛选方案', disabled: true }], onClick: ({ key }) => apply(key) }}
      >
        <Button>筛选方案</Button>
      </Dropdown>
      <SaveScheme schemes={schemes} run={run} />
    </Space>
  )
}
