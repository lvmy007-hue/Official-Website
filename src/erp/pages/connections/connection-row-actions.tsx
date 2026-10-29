import {
  CONNECTION_DISCONNECT_STEP_UP,
  CONNECTION_MANAGE,
  type ActionState,
  type ConnectionDisconnectResult,
  type ConnectionHealthRequested,
  type ConnectionReauthorizeResult,
  type ConnectionRow,
} from '@nova/api-contracts'
import { App } from 'antd'
import { ActionGuard, FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { goToAuthorization } from './redirect'

// 连接的三个动作（P5-04，09 章 9.6）：健康检查、重新授权、断开。授权连接才有；每次都写审计。
// 能不能做由服务端按权限、数据范围与连接状态给出（actions），前端只负责把原因讲清楚；断开要再次验证身份、填原因并勾选确认。

const guardOf = (state: ActionState | undefined) => ({ permission: CONNECTION_MANAGE, condition: { ok: state?.allowed ?? false, reason: state?.reason ?? undefined } })
const idOf = (row: ConnectionRow) => encodeURIComponent(row.connectionId ?? row.id)

export function RowActions({ row, onDone }: { row: ConnectionRow; onDone: (poll?: boolean) => void }) {
  const { message } = App.useApp()
  const check = useApiMutation<void, ConnectionHealthRequested>({ method: 'POST', path: `/connections/${idOf(row)}/health-check`, silent: true })
  const reauthorize = useApiMutation<void, ConnectionReauthorizeResult>({ method: 'POST', path: `/connections/${idOf(row)}/reauthorize`, silent: true })
  const disconnect = useApiMutation<{ reason: string }, ConnectionDisconnectResult>({ method: 'POST', path: `/connections/${idOf(row)}/disconnect`, invalidate: ['reference'], silent: true })
  if (!row.actions) return null
  const { actions } = row
  return (
    <>
      <ActionGuard
        label="健康检查"
        buttonProps={{ size: 'small', type: 'link' }}
        guard={guardOf(actions.healthCheck)}
        onExecute={async () => {
          const result = await check.mutateAsync()
          void message.info(result.alreadyRunning ? '这个连接已有一次检查在进行，稍候刷新查看结果' : '已提交健康检查，结果稍后出现在这一行')
        }}
        onDone={() => onDone(true)}
      />
      <ActionGuard
        label="重新授权"
        buttonProps={{ size: 'small', type: 'link' }}
        guard={guardOf(actions.reauthorize)}
        preview={{
          title: `重新授权：${row.accountLabel}`,
          content: (
            <div>
              <p style={{ marginTop: 0 }}>将跳转到亚马逊的授权页，用同一个账号重新同意授权。授权成功后会替换原来的令牌，并自动做一次健康检查。</p>
              {row.kind === 'SELLER' ? <p style={{ marginBottom: 0 }}>授权的卖家账号必须与当前连接是同一个，换成别的账号会被拒绝；要连接另一个卖家账号请使用“授权卖家接口”。</p> : null}
            </div>
          ),
          confirmText: '前往授权',
        }}
        onExecute={async () => {
          const result = await reauthorize.mutateAsync()
          goToAuthorization(result.authorizationUrl)
        }}
      />
      <FormAction
        label="断开"
        danger
        buttonProps={{ size: 'small', type: 'link' }}
        guard={guardOf(actions.disconnect)}
        title={`断开连接：${row.accountLabel}`}
        description="断开后会删除已保存的令牌，排队中的同步任务全部取消，这个账户的数据不再更新；已同步的历史数据保留。运行中的任务会自行结束。要恢复必须重新授权。"
        reason={{ label: '断开原因', placeholder: '例如：店铺已转让、授权人离职' }}
        confirmText="我确认断开这个连接"
        stepUp={CONNECTION_DISCONNECT_STEP_UP}
        okText="确认断开"
        successText="已断开连接"
        onSubmit={values => disconnect.mutateAsync({ reason: String(values.reason ?? '') })}
        onDone={() => onDone()}
      />
    </>
  )
}
