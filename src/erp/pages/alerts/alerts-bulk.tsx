import { App, Form, Input } from 'antd'
import { ALERTS_HANDLE, ALERTS_READ, ALERT_BATCH_MAX, ALERT_UNREAD_STATUSES, type AlertBatchHandleResponse, type AlertListItem, type AlertReadResponse } from '@nova/api-contracts'
import { ActionGuard, FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 预警列表勾选后的批量动作（P6-15）：标为已读（只改我自己的已读状态）、标为已处理（逐条按“关闭，结论已处理”执行，各条互不影响）。
// 一次最多 ALERT_BATCH_MAX 条；已经已读的、已经结束的预警不会重复处理，按钮上写清楚会处理几条。动作成功后列表与顶栏铃铛一起刷新。

const OPEN = new Set<string>(ALERT_UNREAD_STATUSES)

export function AlertBulkActions({ rows, onDone }: { rows: AlertListItem[]; onDone: () => void }) {
  const { message } = App.useApp()
  const read = useApiMutation<{ ids: string[] }, AlertReadResponse>({ method: 'POST', path: '/alerts/read', invalidate: ['list', 'realtime'] })
  const handle = useApiMutation<{ ids: string[]; note?: string }, AlertBatchHandleResponse>({ method: 'POST', path: '/alerts/handled', invalidate: ['list', 'realtime'] })
  const unreadIds = rows.filter(row => !row.read).map(row => row.id)
  const openIds = rows.filter(row => OPEN.has(row.status)).map(row => row.id)
  const tooMany = rows.length > ALERT_BATCH_MAX
  const limitReason = `一次最多处理 ${ALERT_BATCH_MAX} 条，请少选一些`

  return (
    <>
      <ActionGuard
        label={`标为已读（${unreadIds.length}）`}
        guard={{ permission: ALERTS_READ, condition: { ok: !tooMany && unreadIds.length > 0, reason: tooMany ? limitReason : '选中的预警你都已经读过了' } }}
        successText="已标为已读"
        onDone={onDone}
        onExecute={() => read.mutateAsync({ ids: unreadIds })}
      />
      <FormAction
        label={`标为已处理（${openIds.length}）`}
        guard={{ permission: ALERTS_HANDLE, condition: { ok: !tooMany && openIds.length > 0, reason: tooMany ? limitReason : '选中的预警里没有待处理的' } }}
        title={`把 ${openIds.length} 条预警标为已处理`}
        description="逐条关闭，结论记为“已处理”，关联待办一并完成；已被他人处理的会跳过并说明原因。"
        okText="标为已处理"
        onDone={onDone}
        onSubmit={async values => {
          const note = typeof values.note === 'string' && values.note.trim() ? values.note.trim() : undefined
          const result = await handle.mutateAsync({ ids: openIds, ...(note ? { note } : {}) })
          if (result.skipped.length > 0) void message.warning(`已处理 ${result.handled} 条，跳过 ${result.skipped.length} 条：${result.skipped[0]?.reason ?? ''}`)
          else void message.success(`已处理 ${result.handled} 条`)
          return result
        }}
      >
        <Form.Item label="备注（可选）" name="note">
          <Input.TextArea aria-label="批量处理备注" rows={2} maxLength={1000} />
        </Form.Item>
      </FormAction>
    </>
  )
}
