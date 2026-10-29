import { Form, Input } from 'antd'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { useSession, type Me } from '../../session/session'
import { DensityCard } from './DensityCard'
import { CardRow, InfoCard, PROFILE_PERMISSION, useRefreshMe } from './profile-parts'

// 个人资料（09 章 9.15 第 1 块）：显示名可改；登录邮箱由登录账号决定，不在这里改；所在企业与企业本地时区只读，写明由谁控制。

const MODE_NOTE: Record<Me['accessMode'], string | null> = {
  NORMAL: null,
  INTERNAL_DIRECT: '内部访问模式下使用的是内部人员的账号，不能在这里修改。',
  SUPPORT: '平台支持访问是只读的，不能修改个人资料。',
}

function EditDisplayName({ me }: { me: Me }) {
  const refresh = useRefreshMe()
  const patch = useApiMutation<{ displayName: string }, { displayName: string; changed: boolean }>({ method: 'PATCH', path: '/auth/me', silent: true })
  const blocked = MODE_NOTE[me.accessMode]
  return (
    <FormAction
      label="修改"
      title="修改显示名"
      guard={{ permission: PROFILE_PERMISSION, condition: { ok: !blocked, reason: blocked ?? undefined } }}
      description="显示名会出现在待办、评论、审计记录里，企业里的其他成员都看得到。"
      initialValues={{ displayName: me.user.displayName }}
      successText="显示名已更新"
      onSubmit={async values => {
        await patch.mutateAsync({ displayName: String(values.displayName ?? '').trim() })
        await refresh()
      }}
    >
      <Form.Item
        label="显示名"
        name="displayName"
        rules={[
          { required: true, whitespace: true, message: '请填写显示名' },
          { max: 60, message: '最多 60 个字' },
        ]}
      >
        <Input aria-label="显示名" maxLength={60} />
      </Form.Item>
    </FormAction>
  )
}

export default function ProfileTab() {
  const { me } = useSession()
  const support = me.accessMode === 'SUPPORT'
  return (
    <CardRow>
      <InfoCard id="displayName" name="显示名" value={me.user.displayName} note="待办、评论和审计记录里显示的名字。" action={<EditDisplayName me={me} />} />
      <InfoCard id="email" name="登录邮箱" value={support ? '—' : me.user.email} readonlyBy="登录邮箱是账号标识，不能在这里修改。" />
      <InfoCard id="tenant" name="所在企业" value={me.tenant.name} readonlyBy="由企业管理员在企业设置里维护。" />
      <InfoCard id="zone" name="企业本地时区" value={me.tenant.localTimezone ?? '—'} note="个人免打扰时段按这个时区计算。" readonlyBy="由企业管理员在企业设置里维护，个人不能单独设置。" />
      <DensityCard available={me.accessMode === 'NORMAL'} />
    </CardRow>
  )
}
