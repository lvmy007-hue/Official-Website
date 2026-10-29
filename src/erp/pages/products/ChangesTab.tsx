import { Alert, Space } from 'antd'
import { ASIN360_CHANGE_SOURCE_LABEL, type Asin360ChangesResponse } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { OperationLog, type OperationEntry } from '../../components'
import { useSession } from '../../session/session'
import { QueryBody, useProductQuery } from './asin360-hooks'

// 变更与审计页签（05 章 5.2）：这个商品的系统内操作、亚马逊侧变更（商品目录同步发现的品牌、类目、主图、父体变化）与手工运营记录，
// 合成一条时间线，新的在前；带前后取值的变更直接写出“旧值 → 新值”。手工记录写入运营日志（需要 collab.write）。

const MAX_NOTE = 2000

export function ChangesTab({ id }: { id: string }) {
  const { canPermission } = useSession()
  const query = useProductQuery<Asin360ChangesResponse>(id, 'changes')
  const canWrite = canPermission('collab.write')
  return (
    <QueryBody query={query}>
      {data => {
        const entries: OperationEntry[] = data.items.map(item => ({
          id: item.id,
          at: item.occurredAt,
          source: item.source,
          title: item.title,
          detail: item.before !== null || item.after !== null ? `${item.kindLabel}：${item.before ?? '（无）'} → ${item.after ?? '（无）'}` : item.kindLabel,
          actor: item.actor,
        }))
        return (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {data.truncated ? <Alert type="warning" showIcon message="只显示最近 200 条变更，更早的记录请在审计日志中查看" /> : null}
            <OperationLog
              entries={entries}
              noteDisabledReason={canWrite ? undefined : '需要“collab.write”权限才能补充工作记录'}
              onAddNote={async text => {
                await apiFetch('/operation-logs', {
                  method: 'POST',
                  body: JSON.stringify({ scope: 'ASIN', scopeRef: id, category: 'OTHER', occurredAt: new Date().toISOString(), text: text.slice(0, MAX_NOTE) }),
                })
                await query.refetch()
              }}
            />
            <span style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>
              来源：{Object.values(ASIN360_CHANGE_SOURCE_LABEL).join('、')}。亚马逊侧变更来自每日商品目录同步的比对，时间是同步发现的时间，不是亚马逊实际修改的时间。
            </span>
          </Space>
        )
      }}
    </QueryBody>
  )
}
