import { Form, Select } from 'antd'
import { CONNECTION_MANAGE, type ConnectionCenterResponse } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { goToAuthorization } from './redirect'

// 授权入口（P5-04，09 章 9.6）：授权卖家接口（选法人主体）、授权广告接口。授权在亚马逊页面完成，回来后连接中心自动做一次健康检查。
// 同一个卖家账号再次授权会更新原连接，不会新建重复连接。

type Start = { authorizationUrl: string }

export function AuthorizeActions({ data }: { data: ConnectionCenterResponse | undefined }) {
  const seller = useApiMutation<{ legalEntityId: string }, Start>({ method: 'POST', path: '/sp-api/oauth/start', body: v => ({ legalEntityId: v.legalEntityId, region: 'NA' }), silent: true })
  const ads = useApiMutation<void, Start>({ method: 'POST', path: '/ads/oauth/start', body: () => ({}), silent: true })
  const manage = { permission: CONNECTION_MANAGE, condition: { ok: data?.canManage ?? false, reason: data?.manageBlockedReason ?? undefined } }
  const entities = data?.legalEntities ?? []
  return (
    <>
      <FormAction
        label="授权卖家接口"
        buttonProps={{ type: 'primary' }}
        guard={{ ...manage, condition: entities.length === 0 && data?.canManage ? { ok: false, reason: '请先在“设置”里添加法人主体，再授权卖家接口' } : manage.condition }}
        title="授权卖家接口（亚马逊美国站）"
        description="选择这个店铺所属的法人主体，随后跳转到亚马逊卖家平台同意授权。品牌卖家才能使用品牌分析等数据。"
        initialValues={{ legalEntityId: entities.length === 1 ? entities[0]?.id : undefined }}
        okText="前往亚马逊授权"
        onSubmit={async values => goToAuthorization((await seller.mutateAsync({ legalEntityId: String(values.legalEntityId) })).authorizationUrl)}
      >
        <Form.Item label="法人主体" name="legalEntityId" rules={[{ required: true, message: '请选择法人主体' }]}>
          <Select aria-label="法人主体" placeholder="选择法人主体" options={entities.map(entity => ({ value: entity.id, label: entity.name }))} />
        </Form.Item>
      </FormAction>
      <FormAction
        label="授权广告接口"
        guard={manage}
        title="授权广告接口"
        description="跳转到亚马逊广告平台同意授权。授权后同步广告账户，再在下方把广告账户绑定到对应店铺。"
        okText="前往亚马逊授权"
        onSubmit={async () => goToAuthorization((await ads.mutateAsync()).authorizationUrl)}
      />
    </>
  )
}
