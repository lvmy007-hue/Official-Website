import { App, Form, Input, Select } from 'antd'
import { ADS_ACCOUNT_BIND, ADS_BINDING_REASON_MAX, ADS_BINDING_REASON_MIN, type AdsAccountBindResult, type AdsAccountBindingList, type AdsAccountBindingRow } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 广告账户与店铺的人工绑定（P3-03，09 章 9.6）：绑定、改绑、解除绑定。
// 服务端决定谁能改：要有“广告账户与店铺人工绑定”权限，并且数据范围是“全部店铺”（绑定决定谁能看到这个广告账户的数据）；不满足时按钮禁用并写明原因。
// 第一次绑定不要求原因；改绑与解除绑定要写原因（服务端同样校验）；每次都写审计。

type BindVariables = { id: string; body: { sellerAccountId: string | null; reason?: string } }

export function useBindCall() {
  return useApiMutation<BindVariables, AdsAccountBindResult>({
    method: 'POST',
    path: variables => `/connections/ads-accounts/${encodeURIComponent(variables.id)}/bind`,
    body: variables => variables.body,
    // 绑定改变范围过滤的结果：别的页面缓存的广告数据也要重取
    invalidate: ['reference', 'list', 'analytics'],
    silent: true,
  })
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

function StoreField({ stores, current }: { stores: AdsAccountBindingList['stores']; current?: string | null }) {
  return (
    <Form.Item label="绑定到店铺" name="sellerAccountId" rules={[{ required: true, message: '请选择店铺' }]} extra={current ? undefined : '没有找到店铺？请先在连接中心连接对应的卖家账号。'}>
      <Select
        aria-label="绑定到店铺"
        showSearch
        optionFilterProp="label"
        placeholder="选择店铺"
        options={stores.map(store => ({ value: store.id, label: `${store.displayName}（卖家编号 ${store.sellerId}，${store.logicalRegion}）` }))}
      />
    </Form.Item>
  )
}

export function BindActions({ row, data, onDone }: { row: AdsAccountBindingRow; data: AdsAccountBindingList; onDone: () => void }) {
  const { message } = App.useApp()
  const call = useBindCall()
  const guard = { permission: ADS_ACCOUNT_BIND, condition: { ok: data.canBind, reason: data.bindBlockedReason ?? undefined } }
  const submit = async (sellerAccountId: string | null, reason: string) => {
    const result = await call.mutateAsync({ id: row.id, body: { sellerAccountId, ...(reason ? { reason } : {}) } })
    if (result.warnings.length > 0) void message.warning(result.warnings.join('；'))
    return result
  }
  const bound = row.store !== null
  return (
    <>
      {bound ? (
        <FormAction
          label="改绑"
          buttonProps={{ size: 'small', type: 'link' }}
          guard={guard}
          title={`改绑广告账户：${row.displayName}`}
          description="改绑会改变谁能看到这个广告账户的活动、花费与报表。原绑定的店铺里的成员将不再看到它。"
          reason={{ label: '改绑原因', placeholder: '例如：这个广告账户实际属于另一家店铺' }}
          initialValues={{ sellerAccountId: row.store?.id }}
          okText="确认改绑"
          successText="已改绑"
          onDone={onDone}
          onSubmit={values => submit(String(values.sellerAccountId), text(values.reason))}
        >
          <StoreField stores={data.stores} current={row.store?.id} />
        </FormAction>
      ) : (
        <FormAction
          label="绑定店铺"
          buttonProps={{ size: 'small', type: 'link' }}
          guard={guard}
          title={`绑定广告账户：${row.displayName}`}
          description="绑定后，这个广告账户的数据归入所选店铺，该店铺范围内的成员才能看到；人工绑定不会被自动匹配覆盖。"
          okText="绑定"
          successText="已绑定"
          onDone={onDone}
          onSubmit={values => submit(String(values.sellerAccountId), text(values.note))}
        >
          <StoreField stores={data.stores} />
          <Form.Item
            label="备注（可选）"
            name="note"
            rules={[
              { min: ADS_BINDING_REASON_MIN, message: `至少 ${ADS_BINDING_REASON_MIN} 个字` },
              { max: ADS_BINDING_REASON_MAX, message: `最多 ${ADS_BINDING_REASON_MAX} 个字` },
            ]}
          >
            <Input.TextArea aria-label="备注" rows={2} maxLength={ADS_BINDING_REASON_MAX} showCount />
          </Form.Item>
        </FormAction>
      )}
      {bound || row.bindingStatus === 'MANUAL' ? (
        <FormAction
          label="解除绑定"
          danger
          buttonProps={{ size: 'small', type: 'link' }}
          guard={guard}
          title={`解除绑定：${row.displayName}`}
          description="解除后这个广告账户回到“未绑定”，只有“全部店铺”范围的成员能看到它。之后同步广告账户时，如果卖家编号能唯一对上一家店铺，会再次自动匹配。"
          reason={{ label: '解除原因', placeholder: '例如：确认不属于任何已连接的店铺' }}
          okText="确认解除"
          successText="已解除绑定"
          onDone={onDone}
          onSubmit={values => submit(null, text(values.reason))}
        />
      ) : null}
    </>
  )
}
