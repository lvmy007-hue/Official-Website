import { Space } from 'antd'
import type { ShipFromListResponse, ShipFromRow } from '@nova/api-contracts'
import { SHIP_FROM_MANAGE } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { ShipFromFormItems, shipFromBody, shipFromInitialValues, type ShipFromValues } from './ship-from-form'

// 发货地址的写操作（P6-08）：新增、修改、设为默认、停用与启用、删除。每个都走动作守卫（没有“发货地址维护”权限时按钮禁用并说明原因），
// 结果以服务端为准：修改带着看到的版本号，别人先改过就提示刷新；被入仓计划用过的地址删除会被服务端拒绝，界面如实显示原因。

const guard = { permission: SHIP_FROM_MANAGE }

type Store = { id: string; name: string }
type RowResponse = ShipFromListResponse['items'][number]

function useShipFromWrites() {
  const create = useApiMutation<Record<string, unknown>, RowResponse>({ method: 'POST', path: '/ship-from-addresses', invalidate: ['list', 'reference'], silent: true })
  const update = useApiMutation<{ id: string; body: Record<string, unknown> }, RowResponse>({
    method: 'PUT',
    path: variables => `/ship-from-addresses/${encodeURIComponent(variables.id)}`,
    body: variables => variables.body,
    invalidate: ['list', 'reference'],
    silent: true,
  })
  const makeDefault = useApiMutation<string, RowResponse>({
    method: 'POST',
    path: id => `/ship-from-addresses/${encodeURIComponent(id)}/default`,
    body: () => undefined,
    invalidate: ['list', 'reference'],
    silent: true,
  })
  const remove = useApiMutation<string, { id: string }>({
    method: 'DELETE',
    path: id => `/ship-from-addresses/${encodeURIComponent(id)}`,
    body: () => undefined,
    invalidate: ['list', 'reference'],
    silent: true,
  })
  return { create, update, makeDefault, remove }
}

export function CreateShipFromAction({ stores, onDone }: { stores: readonly Store[]; onDone: () => void }) {
  const writes = useShipFromWrites()
  return (
    <FormAction
      label="新增发货地址"
      guard={guard}
      title="新增发货地址"
      description="补货批次转入仓计划草稿时，会按店铺的默认地址（或你逐条选的地址）填写发货方；地址只保存在我们这里，不会发给亚马逊，直到你提交入仓计划。"
      okText="保存"
      successText="已新增发货地址"
      width={560}
      buttonProps={{ type: 'primary' }}
      initialValues={{ isDefault: false }}
      onSubmit={values => writes.create.mutateAsync(shipFromBody(values as ShipFromValues, 'create'))}
      onDone={onDone}
    >
      <ShipFromFormItems stores={stores} editing={false} />
    </FormAction>
  )
}

export function ShipFromRowActions({ row, stores, onDone }: { row: ShipFromRow; stores: readonly Store[]; onDone: () => void }) {
  const writes = useShipFromWrites()
  const active = row.status === 'ACTIVE'
  return (
    <Space size={4}>
      <FormAction
        label="设为默认"
        guard={{ permission: SHIP_FROM_MANAGE, condition: { ok: active && !row.isDefault, reason: row.isDefault ? '已经是这个店铺的默认地址' : '已停用的地址不能设为默认，请先启用' } }}
        title={`把「${row.name}」设为 ${row.storeName} 的默认地址`}
        description="每个店铺只有一个默认地址；原来的默认地址会同时取消默认。补货转入仓计划草稿时，没有逐条指定地址的建议会用默认地址。"
        okText="设为默认"
        successText="已设为默认"
        buttonProps={{ size: 'small' }}
        onSubmit={() => writes.makeDefault.mutateAsync(row.id)}
        onDone={onDone}
      />
      <FormAction
        label="编辑"
        guard={guard}
        title={`编辑发货地址「${row.name}」`}
        okText="保存修改"
        successText="已保存修改"
        width={560}
        buttonProps={{ size: 'small' }}
        initialValues={shipFromInitialValues(row)}
        onSubmit={values => writes.update.mutateAsync({ id: row.id, body: { version: row.version, ...shipFromBody(values as ShipFromValues, 'update') } })}
        onDone={onDone}
      >
        <ShipFromFormItems stores={stores} editing />
      </FormAction>
      <FormAction
        label={active ? '停用' : '启用'}
        guard={guard}
        title={active ? `停用发货地址「${row.name}」` : `启用发货地址「${row.name}」`}
        description={
          active
            ? row.isDefault
              ? '这是店铺的默认地址：停用后店铺会没有默认地址，补货转入仓计划草稿前要先指定或另设一个。已有的入仓计划不受影响。'
              : '停用后新的草稿不会再选它；已有的入仓计划不受影响。'
            : '启用后可以再被选用，也可以设为默认。'
        }
        okText={active ? '停用' : '启用'}
        successText={active ? '已停用' : '已启用'}
        danger={active}
        buttonProps={{ size: 'small' }}
        onSubmit={() => writes.update.mutateAsync({ id: row.id, body: { version: row.version, status: active ? 'INACTIVE' : 'ACTIVE' } })}
        onDone={onDone}
      />
      <FormAction
        label="删除"
        guard={{ permission: SHIP_FROM_MANAGE, condition: { ok: row.usedByPlans === 0, reason: '这个地址已被入仓计划使用，不能删除；可以改为停用' } }}
        title={`删除发货地址「${row.name}」`}
        description="删除后不能恢复。被入仓计划用过的地址不能删除，只能停用。"
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
