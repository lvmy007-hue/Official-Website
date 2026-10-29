import { useState } from 'react'
import { apiFetch } from '../../../api'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { CommentThread, WatchButton } from './Collaboration'

// 对象的评论与关注（P1-28-10）：把共享的评论组件接到真实接口。
// - 评论列表、关注状态来自 GET /comments；发表走 POST /comments，关注走 POST /watches、取消走 DELETE /watches/:id；
// - 没有 collab.write 权限时输入与关注按钮禁用并说明原因；@ 的候选成员来自成员列表（没有成员查看权限时只能不 @ 人）；
// - 提交失败原样显示服务端的原因，不做假成功。

type CommentRow = { id: string; body: string; author: { id: string; name: string }; mentions: Array<{ id: string; name: string }>; createdAt: string }
type CommentList = { items: CommentRow[]; watch: { watching: boolean; watchId: string | null; watchers: number } }
type MemberRow = { status: string; user: { id: string; displayName: string; email: string } }

const COLLAB = 'collab.write'

export function EntityCollaboration({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { canPermission } = useSession()
  const [watchError, setWatchError] = useState<string | null>(null)
  const canWrite = canPermission(COLLAB)
  const canListMembers = canPermission('member.read')
  const path = '/comments'
  const params = { entityType, entityId }
  const comments = useApiQuery<CommentList>({ domain: 'realtime', path, params, scoped: false })
  const members = useApiQuery<MemberRow[]>({ domain: 'reference', path: '/members/options', scoped: false, enabled: canListMembers })
  const refresh = () => comments.refetch()
  const mentionable = (members.data ?? []).filter(member => member.status === 'ACTIVE').map(member => ({ id: member.user.id, name: member.user.displayName || member.user.email }))
  const watch = comments.data?.watch

  if (comments.isError) return <span role="alert">评论暂时读取失败：{comments.error.message}</span>
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span>{watch ? `${watch.watchers} 人关注` : '读取中'}</span>
        <WatchButton
          watching={watch?.watching ?? false}
          disabledReason={!canWrite ? `需要“${COLLAB}”权限才能关注` : comments.isPending ? '正在读取' : undefined}
          onToggle={async () => {
            setWatchError(null)
            try {
              if (watch?.watching && watch.watchId) await apiFetch(`/watches/${encodeURIComponent(watch.watchId)}`, { method: 'DELETE' })
              else await apiFetch('/watches', { method: 'POST', body: JSON.stringify({ entityType, entityId }) })
              await refresh()
            } catch (error) {
              setWatchError(describeError(error).message)
            }
          }}
        />
      </div>
      {watchError ? (
        <div role="alert" style={{ color: 'var(--ant-color-error)', marginBottom: 8 }}>
          {watchError}
        </div>
      ) : null}
      <CommentThread
        items={(comments.data?.items ?? []).map(item => ({ id: item.id, authorName: item.author.name, body: item.body, createdAt: item.createdAt }))}
        members={mentionable}
        disabledReason={canWrite ? undefined : `需要“${COLLAB}”权限才能发表评论`}
        onSubmit={async ({ body, mentions }) => {
          await apiFetch('/comments', { method: 'POST', body: JSON.stringify({ entityType, entityId, body, mentions }) })
          await refresh()
        }}
      />
    </div>
  )
}
