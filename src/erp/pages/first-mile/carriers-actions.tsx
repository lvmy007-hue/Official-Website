import { Form, Input, InputNumber, Space } from 'antd'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import type { CarrierGridRow } from './carriers-columns'
import { RatesAction } from './RatesDrawer'

// 物流商与渠道的写操作（P6-26）：新增、修改、启用与停用、删除。都走动作守卫（没有“头程物流维护”权限时按钮禁用并说明原因）；
// 修改带看到的版本号，别人先改过会提示刷新；在用的渠道删除会被服务端拒绝，界面如实显示原因。

const guard = { permission: 'firstmile.write' }
const BASE = '/first-mile/carriers'
const code = [{ required: true, pattern: /^[A-Za-z0-9_-]{1,32}$/, message: '1 到 32 位字母、数字、下划线或短横线' }]

type Vars = { path: string; method: 'POST' | 'PUT' | 'DELETE'; body?: Record<string, unknown> }

function useWrite() {
  return useApiMutation<Vars, unknown>({
    method: 'POST',
    path: variables => variables.path,
    body: variables => variables.body,
    invalidate: ['list', 'reference'],
    silent: true,
  })
}

function CarrierItems() {
  return (
    <>
      <Form.Item label="物流商名称" name="name" rules={[{ required: true, whitespace: true, message: '请填写名称' }]}>
        <Input aria-label="物流商名称" maxLength={80} style={{ width: 280 }} />
      </Form.Item>
      <Form.Item label="代码" name="carrierCode" rules={code} extra="企业内唯一，保存时转成大写">
        <Input aria-label="物流商代码" maxLength={32} style={{ width: 200 }} />
      </Form.Item>
    </>
  )
}

function ChannelItems() {
  return (
    <>
      <Form.Item label="渠道名称" name="name" rules={[{ required: true, whitespace: true, message: '请填写名称' }]}>
        <Input aria-label="渠道名称" maxLength={80} style={{ width: 280 }} />
      </Form.Item>
      <Form.Item label="代码" name="carrierCode" rules={code} extra="同一物流商内唯一，保存时转成大写">
        <Input aria-label="渠道代码" maxLength={32} style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="材积除数" name="volumetricDivisor" rules={[{ required: true, message: '请填写材积除数' }]} extra="体积重 = 体积（立方厘米）÷ 除数，空运常见 6000，快递常见 5000">
        <InputNumber aria-label="材积除数" min={1} max={100000} style={{ width: 160 }} />
      </Form.Item>
      <Form.Item label="分抛系数" name="splitFactor" rules={[{ required: true, message: '请填写分抛系数' }]} extra="大于 0 且不超过 1；体积重多出实重的部分只按这个比例计费，1 表示取两者较大者">
        <InputNumber aria-label="分抛系数" min={0.01} max={1} step={0.05} style={{ width: 160 }} />
      </Form.Item>
    </>
  )
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export function CreateCarrierAction({ onDone }: { onDone: () => void }) {
  const write = useWrite()
  return (
    <FormAction
      label="新增物流商"
      guard={guard}
      title="新增物流商"
      okText="保存"
      successText="已新增物流商"
      buttonProps={{ type: 'primary' }}
      onSubmit={values => write.mutateAsync({ path: BASE, method: 'POST', body: { name: text(values.name), code: text(values.carrierCode) } })}
      onDone={onDone}
    >
      <CarrierItems />
    </FormAction>
  )
}

export function CarrierRowActions({ row, onDone }: { row: CarrierGridRow; onDone: () => void }) {
  const write = useWrite()
  const active = row.status === 'ACTIVE'
  const isCarrier = row.kind === 'CARRIER'
  const path = isCarrier ? `${BASE}/${encodeURIComponent(row.id)}` : `${BASE}/${encodeURIComponent(row.carrierId)}/channels/${encodeURIComponent(row.id)}`
  const noun = isCarrier ? '物流商' : '渠道'
  const put = (body: Record<string, unknown>) => write.mutateAsync({ path, method: 'PUT', body: { version: row.version, ...body } })
  return (
    <Space size={4}>
      {isCarrier ? (
        <FormAction
          label="新增渠道"
          guard={{ permission: 'firstmile.write', condition: { ok: active, reason: '物流商已停用，请先启用再添加渠道' } }}
          title={`给「${row.name}」新增渠道`}
          description="渠道是报价的单位：同一物流商的空运、海运、快递各建一个渠道，各自设材积除数与分抛系数。"
          okText="保存"
          successText="已新增渠道"
          buttonProps={{ size: 'small' }}
          initialValues={{ volumetricDivisor: 6000, splitFactor: 1 }}
          onSubmit={values =>
            write.mutateAsync({
              path: `${BASE}/${encodeURIComponent(row.id)}/channels`,
              method: 'POST',
              body: { name: text(values.name), code: text(values.carrierCode), volumetricDivisor: values.volumetricDivisor, splitFactor: values.splitFactor },
            })
          }
          onDone={onDone}
        >
          <ChannelItems />
        </FormAction>
      ) : (
        <RatesAction row={row} onChanged={onDone} />
      )}
      <FormAction
        label="编辑"
        guard={guard}
        title={`编辑${noun}「${row.name}」`}
        okText="保存修改"
        successText="已保存修改"
        buttonProps={{ size: 'small' }}
        initialValues={{ name: row.name, carrierCode: row.code, volumetricDivisor: row.volumetricDivisor ?? undefined, splitFactor: row.splitFactor ?? undefined }}
        onSubmit={values =>
          put(
            isCarrier
              ? { name: text(values.name), code: text(values.carrierCode) }
              : { name: text(values.name), code: text(values.carrierCode), volumetricDivisor: values.volumetricDivisor, splitFactor: values.splitFactor },
          )
        }
        onDone={onDone}
      >
        {isCarrier ? <CarrierItems /> : <ChannelItems />}
      </FormAction>
      <FormAction
        label={active ? '停用' : '启用'}
        guard={guard}
        title={`${active ? '停用' : '启用'}${noun}「${row.name}」`}
        description={active ? '停用后新的运单不能再选它；已经选了它的运单与已有报价不受影响。' : '启用后可以再被运单选用。'}
        okText={active ? '停用' : '启用'}
        successText={active ? '已停用' : '已启用'}
        danger={active}
        buttonProps={{ size: 'small' }}
        onSubmit={() => put({ status: active ? 'INACTIVE' : 'ACTIVE' })}
        onDone={onDone}
      />
      <FormAction
        label="删除"
        guard={{
          permission: 'firstmile.write',
          condition: isCarrier
            ? { ok: (row.channelCount ?? 0) === 0, reason: '先删除它下面的渠道，或改为停用' }
            : { ok: (row.shipmentCount ?? 0) === 0, reason: '已有头程运单选用了这个渠道，不能删除；可以改为停用' },
        }}
        title={`删除${noun}「${row.name}」`}
        description={isCarrier ? '删除后不能恢复。' : '删除后这个渠道的全部报价一并删除，不能恢复。'}
        okText="删除"
        successText="已删除"
        danger
        buttonProps={{ size: 'small' }}
        onSubmit={() => write.mutateAsync({ path, method: 'DELETE' })}
        onDone={onDone}
      />
    </Space>
  )
}
