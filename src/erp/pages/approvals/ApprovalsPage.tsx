import { useCallback, useState } from 'react'
import { Alert, Badge, Card, Menu, Tabs } from 'antd'
import {
  APPROVAL_BOXES,
  APPROVAL_BOX_LABEL,
  APPROVAL_STATES,
  APPROVAL_STATE_LABEL,
  type ApprovalBox,
  type ApprovalCounts,
  type ApprovalListResponse,
  type ApprovalRow,
  type ApprovalState,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { MassiveGrid, PageHeader, type CursorFetcher } from '../../components'
import { buildPath } from '../../query/api-query'
import { ApprovalDrawer } from './ApprovalDrawer'
import { approvalColumns } from './approvals-columns'

// 审批收件箱（P6-27，16 章第 1 节）：左侧“我审批的、我发起的、抄送我的、我处理过的”，顶部“待处理、已处理”，点一行在抽屉里查看摘要并直接审批。
// 只显示与当前用户有关的单据。财务口径、利润公式与业务口径、期间关账已经接入；定价规则与广告规则的人工确认、批量改价、批量改预算
// 在对应模块出现“人工审批”步骤后接入，此前这里不会有这几类单据，也不会用 0 冒充。

const COUNT_KEY: Partial<Record<ApprovalBox, keyof ApprovalCounts>> = { TODO: 'todoPending', SENT: 'sentPending', CC: 'ccPending' }
const EMPTY: Record<ApprovalBox, string> = {
  TODO: '没有需要你审批的单据。财务口径、利润公式与业务口径、期间关账提交审批后，会出现在这里。',
  SENT: '你还没有发起过需要审批的单据。',
  CC: '没有抄送给你的单据。',
  DONE: '你还没有处理过审批。',
}

export default function ApprovalsPage() {
  const [box, setBox] = useState<ApprovalBox>('TODO')
  const [state, setState] = useState<ApprovalState>('PENDING')
  const [counts, setCounts] = useState<ApprovalCounts | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [open, setOpen] = useState<ApprovalRow | null>(null)
  const refresh = useCallback(() => setVersion(current => current + 1), [])

  const fetchPage = useCallback<CursorFetcher<ApprovalRow>>(
    async ({ cursor, limit, signal }) => {
      const response = await apiFetch<ApprovalListResponse>(buildPath('/approvals', { box, state, limit, cursor: cursor ?? undefined }), { signal })
      // 各信箱待处理数与空状态说明以第一块为准
      if (cursor === null) {
        setCounts(response.counts)
        setNote(response.note)
      }
      return { items: response.items, nextCursor: response.pageInfo.hasMore ? response.pageInfo.nextCursor : null, approxTotal: response.pageInfo.approxTotal }
    },
    [box, state],
  )

  return (
    <div data-testid="approvals-page">
      <PageHeader
        title="审批收件箱"
        description="汇总需要你处理、你发起和抄送给你的审批。通过或驳回后，会同步回财务口径、利润公式与业务口径、期间关账等原单据；规则（发起人不能审批自己、需要再次验证身份）与在原页面审批完全一致。"
      />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <Card size="small" data-testid="approval-boxes" style={{ width: 200, flexShrink: 0 }} styles={{ body: { padding: 4 } }}>
          <Menu
            mode="inline"
            selectedKeys={[box]}
            onClick={item => setBox(item.key as ApprovalBox)}
            style={{ border: 0 }}
            items={APPROVAL_BOXES.map(key => {
              const countKey = COUNT_KEY[key]
              const pending = countKey && counts ? counts[countKey] : null
              return {
                key,
                label: (
                  <Badge count={pending ?? 0} size="small" offset={[12, 0]}>
                    {APPROVAL_BOX_LABEL[key]}
                  </Badge>
                ),
              }
            })}
          />
        </Card>
        <Card size="small" style={{ flex: 1, minWidth: 0 }}>
          <Tabs activeKey={state} onChange={key => setState(key as ApprovalState)} items={APPROVAL_STATES.map(key => ({ key, label: APPROVAL_STATE_LABEL[key] }))} />
          {box === 'DONE' && state === 'PENDING' ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="“我处理过的”都是已处理单据，请切到“已处理”查看" /> : null}
          <MassiveGrid<ApprovalRow>
            gridId="approvals.inbox"
            columns={approvalColumns}
            fetchPage={fetchPage}
            getRowId={row => row.id}
            resetKey={JSON.stringify([box, state, version])}
            onRowOpen={setOpen}
            emptyState={{ kind: 'empty', domain: '审批', prerequisite: state === 'DONE' ? '没有已处理的记录。' : (note ?? EMPTY[box]) }}
            height={520}
          />
        </Card>
      </div>
      <ApprovalDrawer row={open} onClose={() => setOpen(null)} onDone={refresh} />
    </div>
  )
}
