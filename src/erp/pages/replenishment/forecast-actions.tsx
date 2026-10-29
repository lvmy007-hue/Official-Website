import { Space } from 'antd'
import { FORECAST_WRITE, type ForecastOverrideRow } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { ForecastFormItems, forecastBody, forecastInitialValues, type ForecastValues } from './forecast-form'

// 人工预测规则的写操作（P6-09）：新增、修改、删除。都走动作守卫（没有“补货策略维护”权限时按钮禁用并说明原因）；
// 结果以服务端为准：对象必须是已有商品、同一对象时间段不能重叠（409 并指出冲突的规则）、修改带版本号（别人先改过会提示刷新）。

const guard = { permission: FORECAST_WRITE }

function useForecastWrites() {
  const create = useApiMutation<Record<string, unknown>, ForecastOverrideRow>({ method: 'POST', path: '/replenishment/forecast-overrides', invalidate: ['list'], silent: true })
  const update = useApiMutation<{ id: string; body: Record<string, unknown> }, ForecastOverrideRow>({
    method: 'PUT',
    path: variables => `/replenishment/forecast-overrides/${encodeURIComponent(variables.id)}`,
    body: variables => variables.body,
    invalidate: ['list'],
    silent: true,
  })
  const remove = useApiMutation<string, { id: string }>({
    method: 'DELETE',
    path: id => `/replenishment/forecast-overrides/${encodeURIComponent(id)}`,
    body: () => undefined,
    invalidate: ['list'],
    silent: true,
  })
  return { create, update, remove }
}

export function CreateForecastAction({ onDone }: { onDone: () => void }) {
  const writes = useForecastWrites()
  return (
    <FormAction
      label="新增规则"
      guard={guard}
      title="新增人工预测规则"
      description="在这段时间里用你给的日销取代模型预测；只影响之后重新计算的批次。"
      okText="保存"
      successText="已新增规则"
      width={560}
      buttonProps={{ type: 'primary' }}
      initialValues={{ scopeType: 'SKU', mode: 'FIXED' }}
      onSubmit={values => writes.create.mutateAsync(forecastBody(values as ForecastValues, 'create'))}
      onDone={onDone}
    >
      <ForecastFormItems editing={false} />
    </FormAction>
  )
}

export function ForecastRowActions({ row, onDone }: { row: ForecastOverrideRow; onDone: () => void }) {
  const writes = useForecastWrites()
  const expired = row.status === 'EXPIRED'
  return (
    <Space size={4}>
      <FormAction
        label="编辑"
        guard={{ permission: FORECAST_WRITE, condition: { ok: !expired, reason: '这条规则已经结束，不能再修改；如需沿用请新建一条' } }}
        title={`编辑规则：${row.scopeId}`}
        okText="保存修改"
        successText="已保存修改"
        width={560}
        buttonProps={{ size: 'small' }}
        initialValues={forecastInitialValues(row)}
        onSubmit={values => writes.update.mutateAsync({ id: row.id, body: forecastBody(values as ForecastValues, 'update', row.version) })}
        onDone={onDone}
      >
        <ForecastFormItems editing />
      </FormAction>
      <FormAction
        label="删除"
        guard={guard}
        title={`删除规则：${row.scopeId}`}
        description="删除后不能恢复。已生成的批次保持当时的结果，只有之后重新计算才不再使用这条规则。"
        okText="删除"
        successText="已删除"
        danger
        buttonProps={{ size: 'small' }}
        onSubmit={() => writes.remove.mutateAsync(row.id)}
        onDone={onDone}
      />
    </Space>
  )
}
