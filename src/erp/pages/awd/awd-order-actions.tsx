import { Alert, Form, Input } from 'antd'
import type { AwdActionResponse, AwdOrderDetail } from '@nova/api-contracts'
import { ActionGuard, FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { awdGuard } from './awd-ui'

// 入库订单详情上的动作：编辑、提交亚马逊、确认、取消、运输信息。
// 可用的动作由服务端按订单当前状态算出（order.actions）；有后台操作在途时一个都不给。
// 调用亚马逊的动作按“权限 → 店铺连接 → 写入开关”守卫，按钮禁用时写明卡在哪一步；只改本地的动作只要权限。
// 提交后订单显示“处理中”，成功与否以订单状态为准，页面不做假成功。

export function OrderActions({ order, onEdit }: { order: AwdOrderDetail; onEdit: () => void }) {
  const base = `/awd/orders/${encodeURIComponent(order.id)}`
  const patch = useApiMutation<Record<string, unknown>, AwdActionResponse>({ method: 'PATCH', path: base, invalidate: ['list'], silent: true })
  const confirm = useApiMutation<void, AwdActionResponse>({ method: 'POST', path: `${base}/confirm`, body: () => ({ version: order.version }), invalidate: ['list'], silent: true })
  const cancel = useApiMutation<string, AwdActionResponse>({ method: 'POST', path: `${base}/cancel`, body: reason => ({ version: order.version, reason }), invalidate: ['list'], silent: true })
  const local = order.status === 'LOCAL_DRAFT' || order.status === 'CREATE_FAILED'
  const has = (action: AwdOrderDetail['actions'][number]) => order.actions.includes(action)
  const write = order.write

  return (
    <>
      {has('EDIT') ? <ActionGuard label="编辑" guard={awdGuard(write, { amazon: !local })} onExecute={async () => onEdit()} /> : null}
      {has('SUBMIT') ? (
        <FormAction
          label={order.status === 'CREATE_FAILED' ? '重新提交亚马逊' : '提交亚马逊'}
          guard={awdGuard(write, { amazon: true })}
          title="提交到亚马逊仓储分销"
          description={
            <Alert type="info" showIcon message="提交后会在亚马逊上创建入库订单草稿（还不会发货），由后台任务完成；订单显示“处理中”，结果以订单状态为准。提交前每个包装都要有重量与长宽高。" />
          }
          okText="提交"
          successText="已交给后台任务提交亚马逊"
          buttonProps={{ type: 'primary' }}
          onSubmit={() => patch.mutateAsync({ version: order.version, submit: true })}
        />
      ) : null}
      {has('CONFIRM') ? (
        <FormAction
          label="确认订单"
          guard={awdGuard(write, { amazon: true })}
          title="确认入库订单"
          description={<Alert type="warning" showIcon message="确认后亚马逊开始处理并生成入库货件，包装不能再修改；要改只能取消后重建。" />}
          confirmText="我已核对包装与数量，确认提交给亚马逊"
          okText="确认订单"
          successText="已交给后台任务确认订单"
          buttonProps={{ type: 'primary' }}
          onSubmit={() => confirm.mutateAsync()}
        />
      ) : null}
      {has('TRANSPORT') ? (
        <FormAction
          label="更新运输信息"
          guard={awdGuard(write, { amazon: true })}
          title="更新运输信息"
          description="把承运商的预约号或追踪号告诉亚马逊（订单已确认、有入库货件时才能更新）。"
          okText="提交"
          successText="已交给后台任务更新运输信息"
          onSubmit={values =>
            patch.mutateAsync({
              version: order.version,
              transport: { bookingId: String(values.bookingId ?? '').trim(), ...(values.carrierCode ? { carrierCode: String(values.carrierCode).trim() } : {}) },
            })
          }
        >
          <Form.Item label="承运商代码（SCAC，选填）" name="carrierCode" rules={[{ pattern: /^[A-Za-z]{2,4}$/, message: '2 到 4 位字母，例如 UPSN' }]}>
            <Input aria-label="承运商代码" maxLength={4} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item label="预约号或追踪号" name="bookingId" rules={[{ required: true, whitespace: true, message: '请填写预约号或追踪号' }]}>
            <Input aria-label="预约号或追踪号" maxLength={120} />
          </Form.Item>
        </FormAction>
      ) : null}
      {has('CANCEL') ? (
        <FormAction
          label="取消订单"
          danger
          guard={awdGuard(write, { amazon: !local })}
          title="取消入库订单"
          description={local ? '只取消这份本地草稿，不会调用亚马逊。' : '会向亚马逊取消这个订单，由后台任务完成；已经发出的货件需要另行处理。'}
          reason={{ label: '取消原因', placeholder: '例如：计划变更、重复下单' }}
          okText="取消订单"
          successText={local ? '已取消' : '已交给后台任务取消订单'}
          onSubmit={values => cancel.mutateAsync(String(values.reason))}
        />
      ) : null}
    </>
  )
}
