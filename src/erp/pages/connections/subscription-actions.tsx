import { Form, Select } from 'antd'
import { FILTER_AGGREGATION_OPTIONS, SUBSCRIPTION_MANAGE, US_MARKETPLACE_ID, type ActionState, type SubscriptionFilterView, type SubscriptionItem } from '@nova/api-contracts'
import { ActionGuard, FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 订阅的四个动作（P5-05，09 章 9.7）：订阅、修改过滤条件、取消订阅、重放失败事件。
// 能不能做、不能做的原因都由服务端给出（actions），这里只负责把原因讲清楚；创建与取消在亚马逊侧由后台任务完成，所以提交成功只代表“已登记”。

const guardOf = (state: ActionState) => ({ permission: SUBSCRIPTION_MANAGE, condition: { ok: state.allowed, reason: state.reason ?? undefined } })
const small = { size: 'small', type: 'link' } as const
const pathOf = (row: SubscriptionItem) => `/notifications/subscriptions/${encodeURIComponent(row.id ?? '')}`

type Values = Record<string, unknown>

/** 过滤条件只有两项：站点（目前只支持美国站）与聚合周期；都不选等于不过滤。 */
export function filterFromValues(values: Values): SubscriptionFilterView {
  const filter: SubscriptionFilterView = {}
  if (values.marketplace === US_MARKETPLACE_ID) filter.marketplaceIds = [US_MARKETPLACE_ID]
  if (typeof values.aggregationTimePeriod === 'string' && values.aggregationTimePeriod) filter.aggregationTimePeriod = values.aggregationTimePeriod
  return filter
}

export function filterInitial(filter: SubscriptionFilterView | null) {
  return { marketplace: filter?.marketplaceIds?.[0], aggregationTimePeriod: filter?.aggregationTimePeriod }
}

function FilterFields() {
  return (
    <>
      <Form.Item label="站点" name="marketplace" extra="目前只支持亚马逊美国站；不选表示不按站点过滤。">
        <Select aria-label="过滤站点" allowClear placeholder="不过滤" options={[{ value: US_MARKETPLACE_ID, label: '美国站' }]} />
      </Form.Item>
      <Form.Item label="聚合周期" name="aggregationTimePeriod" extra="报价变化按这个周期合并后推送；不选使用亚马逊默认周期。">
        <Select aria-label="聚合周期" allowClear placeholder="默认" options={FILTER_AGGREGATION_OPTIONS.map(item => ({ value: item.value, label: item.label }))} />
      </Form.Item>
    </>
  )
}

export function RowActions({ row, onDone }: { row: SubscriptionItem; onDone: (poll?: boolean) => void }) {
  const create = useApiMutation<{ filter?: SubscriptionFilterView }, unknown>({
    method: 'POST',
    path: '/notifications/subscriptions',
    body: v => ({ sellerAccountId: row.sellerAccountId, notificationType: row.notificationType, ...(v.filter && Object.keys(v.filter).length ? { filter: v.filter } : {}) }),
    silent: true,
  })
  const update = useApiMutation<{ filter: SubscriptionFilterView }, unknown>({ method: 'PATCH', path: pathOf(row), body: v => ({ version: row.version, filter: v.filter }), silent: true })
  const remove = useApiMutation<void, unknown>({ method: 'DELETE', path: pathOf(row), silent: true })
  const replay = useApiMutation<void, { replayed: number }>({ method: 'POST', path: `${pathOf(row)}/replay`, body: () => ({ allFailed: true }), silent: true })
  const { actions } = row
  if (!row.id) {
    const common = {
      label: '订阅',
      buttonProps: small,
      guard: guardOf(actions.subscribe),
      title: `订阅：${row.label}（${row.storeName}）`,
      okText: '确认订阅',
      successText: '已登记订阅，创建由后台任务完成，状态稍后更新',
      onDone: () => onDone(true),
    }
    return row.filterable ? (
      <FormAction {...common} description="可以按站点与聚合周期过滤事件；不选就订阅全部事件。" onSubmit={values => create.mutateAsync({ filter: filterFromValues(values) })}>
        <FilterFields />
      </FormAction>
    ) : (
      <ActionGuard
        label={common.label}
        buttonProps={small}
        guard={common.guard}
        preview={{
          title: common.title,
          content: (
            <p style={{ margin: 0 }}>
              订阅后，亚马逊会把「{row.label}」事件推送到接收端，并用于：{row.pages.join('、')}。
            </p>
          ),
          confirmText: common.okText,
        }}
        onExecute={() => create.mutateAsync({})}
        successText={common.successText}
        onDone={common.onDone}
      />
    )
  }
  return (
    <>
      <FormAction
        label="改过滤条件"
        buttonProps={small}
        guard={guardOf(actions.editFilter)}
        title={`修改过滤条件：${row.label}（${row.storeName}）`}
        description="亚马逊不支持原地修改：提交后先取消旧订阅，再按新条件重新创建，这期间可能漏掉少量事件。"
        initialValues={filterInitial(row.filter)}
        okText="确认修改"
        successText="已提交修改，重建由后台任务完成，状态稍后更新"
        onSubmit={values => update.mutateAsync({ filter: filterFromValues(values) })}
        onDone={() => onDone(true)}
      >
        <FilterFields />
      </FormAction>
      <ActionGuard
        label="重放失败事件"
        buttonProps={small}
        guard={guardOf(actions.replay)}
        preview={{
          title: `重放失败事件：${row.label}（${row.storeName}）`,
          content: <p style={{ margin: 0 }}>把这个店铺这类推送下的失败事件（最多 200 条）重新交给处理程序；仍然失败的会再次标为失败。</p>,
          confirmText: '确认重放',
        }}
        onExecute={() => replay.mutateAsync()}
        successText="已提交重放，处理结果稍后更新"
        onDone={() => onDone(true)}
      />
      <ActionGuard
        label="取消订阅"
        danger
        buttonProps={small}
        guard={guardOf(actions.unsubscribe)}
        preview={{
          title: `取消订阅：${row.label}（${row.storeName}）`,
          content: <p style={{ margin: 0 }}>取消后亚马逊不再推送这类事件，{row.pages.join('、')}会退化为按补偿频率定时同步。已收到的事件不受影响。</p>,
          confirmText: '确认取消订阅',
        }}
        onExecute={() => remove.mutateAsync()}
        successText="已提交取消订阅，由后台任务完成"
        onDone={() => onDone(true)}
      />
    </>
  )
}
