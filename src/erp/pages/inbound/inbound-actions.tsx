import type { ReactNode } from 'react'
import { Alert } from 'antd'
import type { InboundAction, InboundActionResponse, InboundBoxesResponse, InboundOverview, InboundPlanRow, InboundWriteStatus } from '@nova/api-contracts'
import { ActionGuard, FormAction, type GuardInput } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { inboundGuard } from './inbound-ui'

// 入仓计划上的动作。可用的动作由服务端按计划状态算出（overview.actions，和后端校验用同一份规则），有操作在途时一个都不给。
// 调用亚马逊的动作按“权限 → 店铺连接 → 写入开关”守卫：按钮禁用时悬停写明卡在哪一步；生成方案、资格预检、取标签不受开关控制；
// 只改本地的动作（保存箱内物品、标记已发货、取消本地草稿）只要权限。每个动作先弹出说明（预览）再提交，结果以服务端返回的计划状态为准。

export const SWITCH = {
  create: 'sw.inbound.plan.create',
  packing: 'sw.inbound.packing.confirm',
  packingInfo: 'sw.inbound.packinginfo.submit',
  placement: 'sw.inbound.placement.confirm',
  transport: 'sw.inbound.transport.confirm',
} as const

/** 取某个写入开关（或“不受开关控制”）对应的守卫状态。 */
export const writeOf = (overview: InboundOverview, switchKey: string | null): InboundWriteStatus | undefined => overview.write[switchKey ?? 'NONE']

export function guardFor(overview: InboundOverview, action: InboundAction, switchKey: string | null, amazon = true): GuardInput {
  const state = overview.actions[action]
  return inboundGuard(writeOf(overview, switchKey), { amazon, condition: { ok: state.allowed, reason: state.reason ?? undefined } })
}

type Call = { path: string; body: unknown }
/** 对一个计划的写请求：成功后让列表与详情重新取数。 */
export function usePlanWrite(planId: string) {
  const base = `/inbound/plans/${encodeURIComponent(planId)}`
  const options = { path: (call: Call) => `${base}${call.path}`, body: (call: Call) => call.body, invalidate: ['list'] as const, silent: true }
  const post = useApiMutation<Call, InboundActionResponse>({ method: 'POST', ...options })
  const put = useApiMutation<Call, InboundActionResponse>({ method: 'PUT', ...options })
  const patch = useApiMutation<Call, InboundActionResponse>({ method: 'PATCH', ...options })
  return {
    post: (path: string, body: unknown) => post.mutateAsync({ path, body }),
    put: (path: string, body: unknown) => put.mutateAsync({ path, body }),
    patch: (path: string, body: unknown) => patch.mutateAsync({ path, body }),
  }
}

export const versionOf = (plan: InboundPlanRow) => ({ version: plan.version })

/** 生成类动作（装箱方案、分仓方案、送达时间窗）：不受写入开关控制，只产生可比较的方案。 */
export function GenerateAction({
  overview,
  action,
  path,
  label,
  body = {},
  hint,
}: {
  overview: InboundOverview
  action: InboundAction
  path: string
  label: string
  body?: Record<string, unknown>
  hint: string
}) {
  const write = usePlanWrite(overview.plan.id)
  if (!overview.actions[action].allowed) return null
  return (
    <ActionGuard
      label={label}
      guard={guardFor(overview, action, null)}
      preview={{ title: label, content: <Alert type="info" showIcon message={hint} />, confirmText: '开始生成' }}
      successText="已交给后台任务，亚马逊处理完成后方案会出现在页面上"
      onExecute={() => write.post(path, { action: 'GENERATE', ...body, ...versionOf(overview.plan) })}
    />
  )
}

function Preview({ overview }: { overview: InboundOverview }): ReactNode {
  const units = overview.plan.totalUnits
  return (
    <Alert
      type="warning"
      showIcon
      message={`将在亚马逊创建入仓计划：${overview.items.length} 个 SKU，共 ${units} 件`}
      description="由后台任务提交，计划显示“处理中”直到亚马逊返回；创建后装箱方案有效期内要完成确认。预处理与贴标固定由卖家负责。"
    />
  )
}

/** 头部动作：资格预检、提交创建、提交箱内物品、标记已发货、取消。其余动作在对应页签里。 */
export function PlanActions({ overview }: { overview: InboundOverview }) {
  const { plan, actions } = overview
  const write = usePlanWrite(plan.id)
  const boxes = useApiQuery<InboundBoxesResponse>({ domain: 'list', path: `/inbound/plans/${encodeURIComponent(plan.id)}/boxes`, scoped: false, enabled: actions.SUBMIT_PACKING_INFO.allowed })
  const boxesOk = boxes.data?.validation.ok
  const local = plan.externalPlanId === null
  return (
    <>
      {actions.ELIGIBILITY.allowed ? (
        <ActionGuard
          label="资格预检"
          guard={guardFor(overview, 'ELIGIBILITY', null)}
          preview={{
            title: '入仓资格预检',
            content: <Alert type="info" showIcon message={`逐个 SKU 向亚马逊查询能否入仓（${overview.items.length} 个），不会修改任何数据。`} />,
            confirmText: '开始预检',
          }}
          successText="已交给后台任务，完成后每个 SKU 会显示是否合格"
          onExecute={() => write.post('/eligibility', versionOf(plan))}
        />
      ) : null}
      {actions.SUBMIT.allowed ? (
        <FormAction
          label="提交创建"
          guard={guardFor(overview, 'SUBMIT', SWITCH.create)}
          title="提交到亚马逊创建入仓计划"
          description={<Preview overview={overview} />}
          confirmText="我已核对商品与数量，提交给亚马逊"
          okText="提交"
          successText="已交给后台任务创建入仓计划"
          buttonProps={{ type: 'primary' }}
          onSubmit={() => write.post('/submit', versionOf(plan))}
        />
      ) : null}
      {actions.SUBMIT_PACKING_INFO.allowed ? (
        <FormAction
          label="提交箱内物品"
          guard={inboundGuard(writeOf(overview, SWITCH.packingInfo), {
            amazon: true,
            condition: { ok: boxesOk === true, reason: boxesOk === false ? '箱内物品与计划数量不一致，先在“箱内物品”页签里修正' : '箱内物品加载中' },
          })}
          title="提交箱内物品信息"
          description={<Alert type="warning" showIcon message="提交后亚马逊按箱内物品生成分仓方案；提交后不能再改箱子，要改只能取消重建。" />}
          confirmText="我已核对每个 SKU 的装箱总数与计划一致"
          okText="提交"
          successText="已交给后台任务提交箱内物品信息"
          buttonProps={{ type: 'primary' }}
          onSubmit={() => write.post('/packing-info', versionOf(plan))}
        />
      ) : null}
      {actions.MARK_SHIPPED.allowed ? (
        <FormAction
          label="标记已发货"
          guard={guardFor(overview, 'MARK_SHIPPED', null, false)}
          title="标记已发货"
          description={<Alert type="info" showIcon message="只改变我们这里的状态（亚马逊没有“发货”操作），不会调用亚马逊；发货后作废窗口外不能再取消计划。" />}
          confirmText="货物已经交给承运商"
          okText="标记已发货"
          successText="已标记为已发货"
          buttonProps={{ type: 'primary' }}
          onSubmit={() => write.post('/confirm', versionOf(plan))}
        />
      ) : null}
      {actions.CANCEL.allowed ? (
        <FormAction
          label="取消计划"
          danger
          guard={guardFor(overview, 'CANCEL', local ? null : SWITCH.create, !local)}
          title="取消入仓计划"
          description={<Alert type="warning" showIcon message={local ? '只取消这份本地草稿，不会调用亚马逊。' : overview.cancelNote} />}
          reason={{ label: '取消原因', placeholder: '例如：计划变更、重复下单' }}
          okText="取消计划"
          successText={local ? '已取消' : '已交给后台任务取消计划'}
          onSubmit={values => write.post('/cancel', { ...versionOf(plan), reason: String(values.reason) })}
        />
      ) : null}
    </>
  )
}
