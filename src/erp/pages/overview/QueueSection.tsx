import { useMemo, useState } from 'react'
import { Tag, Typography } from 'antd'
import { renderColumn, type ErpColDef } from '../../components'
import { DetailGrid } from '../orders/DetailGrid'
import { useApiQuery } from '../../query/api-query'
import { RowActions, SEVERITY_TAG, WorkDrawer, dueText, type WorkItemRow } from '../my/work-parts'
import { DrillLink, Section } from './dash-parts'

// 待我处理（04 章 4.1 第 4 项）：直接复用“我的待办”的数据与操作（确认、转派、延期、关闭、忽略），在首页就能处理。
// 只取与我相关的前 5 条未处理待办，完整列表在“我的待办”页。

type Page = { items: WorkItemRow[]; pageInfo: { hasMore: boolean } }
const SHOWN = 5

export function QueueSection() {
  const [openId, setOpenId] = useState<string | null>(null)
  const query = useApiQuery<Page>({ domain: 'realtime', path: '/work-items', scoped: false, params: { tab: 'MINE', scope: 'mine', limit: SHOWN } })
  const refetch = query.refetch
  const refresh = () => void refetch()
  const columns = useMemo<ErpColDef<WorkItemRow>[]>(
    () => [
      renderColumn<WorkItemRow>(
        '待办',
        'title',
        item => (
          <div>
            <Typography.Link onClick={() => setOpenId(item.id)}>{item.title}</Typography.Link>
            {item.entity?.label ? <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>{item.entity.label}</div> : null}
          </div>
        ),
        { width: 320, sortable: false, wrapText: true, autoHeight: true },
      ),
      renderColumn<WorkItemRow>(
        '严重度',
        'severity',
        item => <Tag color={SEVERITY_TAG[item.severity as keyof typeof SEVERITY_TAG]?.[1]}>{SEVERITY_TAG[item.severity as keyof typeof SEVERITY_TAG]?.[0] ?? item.severity}</Tag>,
        {
          width: 100,
          sortable: false,
        },
      ),
      renderColumn<WorkItemRow>('处理时限', 'due', item => <span style={{ color: item.overdue ? 'var(--ant-color-error)' : undefined }}>{dueText(item)}</span>, { width: 240, sortable: false }),
      renderColumn<WorkItemRow>('操作', 'actions', item => <RowActions item={item} onDone={() => void refetch()} />, { width: 360, sortable: false, wrapText: true, autoHeight: true }),
    ],
    [refetch],
  )
  return (
    <Section title="待我处理" extra={<DrillLink component="MyWorkItemsPage" label="查看全部" />} testId="queue-section">
      <DetailGrid<WorkItemRow>
        gridId="overview.queue"
        height={330}
        columns={columns}
        rows={query.data?.items}
        getRowId={item => item.id}
        loading={query.isPending}
        error={query.error}
        onRetry={refresh}
        emptyState={{ kind: 'empty', domain: '待处理事项', prerequisite: '预警触发、同事指派或手工创建后会出现在这里。' }}
      />
      {query.data?.pageInfo.hasMore ? <Typography.Text type="secondary">还有更多待办，请到“我的待办”查看。</Typography.Text> : null}
      <WorkDrawer id={openId} onClose={() => setOpenId(null)} />
    </Section>
  )
}
