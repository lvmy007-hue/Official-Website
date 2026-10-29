import { useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { Alert, Button, Card, Form, Input, Switch } from 'antd'
import { hasPermission } from '@nova/authz'
import { DASHBOARD_SHARE, DASHBOARD_WRITE } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { PageHeader, PagedGrid, textColumn, type PageFetcher } from '../../components'
import { useSession } from '../../session/session'
import { DashboardTree, type DashCard, type FolderNode } from './dashboard-tree'

// 自定义仪表盘列表（P6-33）：左侧文件夹，右侧用页码表格列出仪表盘。

interface Tree {
  folders: FolderNode[]
  dashboards: DashCard[]
  shared: DashCard[]
}

interface List {
  items: Array<DashCard & { version: number; refreshMinutes: number | null }>
  total: number
}

export default function DashboardsPage() {
  const { me } = useSession()
  const canWrite = hasPermission(me.permissions, DASHBOARD_WRITE)
  const canShare = hasPermission(me.permissions, DASHBOARD_SHARE)
  const search = useRouterState({ select: state => state.location.searchStr })
  const [folderId, setFolderId] = useState<string | null>(null)
  const [tree, setTree] = useState<Tree>({ folders: [], dashboards: [], shared: [] })
  const [version, setVersion] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [form] = Form.useForm<{ name: string; folderName: string; shared: boolean }>()

  const loadTree = async () => {
    const data = await apiFetch<Tree>('/dashboards/tree')
    setTree(data)
  }

  const fetchPage: PageFetcher<List['items'][number]> = async ({ page, pageSize }) => {
    if (tree.folders.length === 0 && tree.dashboards.length === 0) await loadTree()
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
    if (folderId) query.set('folderId', folderId)
    const data = await apiFetch<List>(`/dashboards?${query.toString()}`)
    return { items: data.items, total: data.total }
  }

  const createFolder = async () => {
    const values = await form.validateFields(['folderName'])
    await apiFetch('/dashboards/folders', { method: 'POST', body: JSON.stringify({ name: values.folderName, parentId: folderId }) })
    form.resetFields(['folderName'])
    await loadTree()
  }

  const createDashboard = async () => {
    const values = await form.validateFields(['name'])
    await apiFetch('/dashboards', {
      method: 'POST',
      body: JSON.stringify({ name: values.name, folderId, shared: canShare && values.shared === true }),
    })
    setMessage(null)
    setVersion(value => value + 1)
    await loadTree()
  }

  return (
    <>
      <PageHeader title="自定义仪表盘" description="左侧是文件夹，右侧是仪表盘。打开后在画布上排组件，每个组件绑定一个已有数据源。" />
      <div style={{ display: 'flex', gap: 16 }}>
        <DashboardTree
          folders={tree.folders}
          selected={folderId}
          onSelect={id => {
            setFolderId(id)
            setVersion(value => value + 1)
          }}
          extra={
            tree.shared.length ? (
              <div>
                {tree.shared.map(item => (
                  <div key={item.id}>
                    <a href={`/app/dashboards/${item.id}${search}`}>{item.name}（共享）</a>
                  </div>
                ))}
              </div>
            ) : null
          }
        />
        <div style={{ flex: 1 }}>
          <PagedGrid
            gridId="dashboards.list"
            resetKey={`${folderId ?? 'all'}:${version}`}
            columns={[
              textColumn<List['items'][number]>('名称', 'name', { flex: 1 }),
              textColumn<List['items'][number]>('共享', 'shared', { valueFormatter: params => (params.value ? '已共享' : '仅自己') }),
              {
                headerName: '打开',
                colId: 'open',
                width: 90,
                cellRenderer: ({ data }: { data?: List['items'][number] }) => (data ? <a href={`/app/dashboards/${data.id}${search}`}>打开</a> : null),
              },
            ]}
            fetchPage={fetchPage}
            getRowId={row => row.id}
            emptyState={{ kind: 'empty', domain: '仪表盘', prerequisite: '保存一个仪表盘后，可以在这里打开' }}
            height={360}
          />
          {message ? <Alert type="info" showIcon message={message} /> : null}
          {canWrite ? (
            <Card size="small" title="新建" style={{ marginTop: 12 }}>
              <Form form={form} layout="vertical" initialValues={{ shared: false }} onFinish={() => undefined}>
                <Form.Item name="folderName" label="文件夹名称">
                  <Input aria-label="文件夹名称" />
                </Form.Item>
                <Button onClick={() => void createFolder().catch((error: unknown) => setMessage(error instanceof Error ? error.message : '保存失败'))}>新建文件夹</Button>
                <Form.Item name="name" label="仪表盘名称" rules={[{ required: true, message: '请填写名称' }]} style={{ marginTop: 12 }}>
                  <Input aria-label="仪表盘名称" />
                </Form.Item>
                {canShare ? (
                  <Form.Item name="shared" label="共享给团队" valuePropName="checked">
                    <Switch aria-label="共享给团队" />
                  </Form.Item>
                ) : null}
                <Button type="primary" onClick={() => void createDashboard().catch((error: unknown) => setMessage(error instanceof Error ? error.message : '保存失败'))}>
                  保存仪表盘
                </Button>
              </Form>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  )
}
