import { useState } from 'react'
import { useParams } from '@tanstack/react-router'
import type { LegalEntityDetail, LegalEntityUpdateResult } from '@nova/api-contracts'
import { DataState, DetailLayout, FormAction, stateFromError } from '../../components'
import type { IdentityMetric } from '../../components/detail/DetailLayout'
import { formatDate } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { AssetsTab, ChangesTab, InfoTab, MembersTab } from './entities-tabs'
import { EntityFields, countText, updateBody } from './entities-ui'

// 法律主体详情（P5-07，09 章 9.9；骨架：整页详情）：基本资料、名下店铺与广告账户、被授权访问该主体的成员、变更记录。
// 能不能编辑、能不能停用都由服务端返回（含原因），页面只负责置灰与说明；修改带着看到的版本号，别人先改过会提示刷新。

const TABS = [
  ['info', '基本资料'],
  ['assets', '名下店铺与广告账户'],
  ['members', '被授权成员'],
  ['changes', '变更记录'],
] as const

export default function EntityDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const [tab, setTab] = useState<string>('info')
  const path = `/entities/${encodeURIComponent(id)}`
  const query = useApiQuery<LegalEntityDetail>({ domain: 'list', path, scoped: false })
  const update = useApiMutation<Record<string, unknown>, LegalEntityUpdateResult>({ method: 'PATCH', path, invalidate: ['list', 'reference'], silent: true })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'entity.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const detail = query.data
  const { entity } = detail
  const active = entity.status === 'ACTIVE'
  const write = { permission: 'entity.write', condition: { ok: detail.canWrite, reason: detail.writeBlockedReason ?? undefined } }
  const metrics: IdentityMetric[] = [
    { label: '店铺数', value: countText(entity.storeCount) },
    { label: '广告账户数', value: countText(entity.adsAccountCount) },
    { label: '被授权成员', value: detail.members.state === 'OK' ? countText(detail.members.items.length) : <Muted>无权查看</Muted> },
    { label: '创建时间', value: formatDate(entity.createdAt) },
  ]
  const body: Record<string, JSX.Element> = {
    info: <InfoTab detail={detail} />,
    assets: <AssetsTab detail={detail} />,
    members: <MembersTab detail={detail} />,
    changes: <ChangesTab detail={detail} />,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AppLink to="/app/entities">返回法律主体</AppLink>
      <DetailLayout
        title={entity.name}
        subtitle={entity.registrationNo ? `${entity.registeredCountry} · ${entity.registrationNo}` : entity.registeredCountry}
        statuses={[{ text: active ? '使用中' : '已停用', color: active ? 'success' : 'default' }]}
        metrics={metrics}
        primaryActions={
          <>
            <FormAction
              label="编辑"
              guard={write}
              title="编辑法律主体"
              initialValues={{ name: entity.name, registeredCountry: entity.registeredCountry, registrationNo: entity.registrationNo ?? '' }}
              okText="保存"
              successText="已保存"
              onSubmit={values => update.mutateAsync(updateBody(values, entity.version))}
            >
              <EntityFields />
            </FormAction>
            {active ? (
              <FormAction
                label="停用"
                danger
                guard={{ ...write, condition: { ok: detail.canDeactivate, reason: detail.deactivateBlockedReason ?? detail.writeBlockedReason ?? undefined } }}
                title="停用法律主体"
                description="停用后不能再用它授权新店铺，列表里保留历史。名下没有店铺时才能停用。"
                reason={{ label: '停用原因', placeholder: '例如：主体已注销' }}
                okText="停用"
                successText="已停用"
                onSubmit={values => update.mutateAsync({ version: entity.version, status: 'INACTIVE', reason: values.reason })}
              />
            ) : (
              <FormAction
                label="恢复使用"
                guard={write}
                title="恢复使用"
                description="恢复后可以再用它授权新店铺。"
                okText="恢复"
                successText="已恢复使用"
                onSubmit={() => update.mutateAsync({ version: entity.version, status: 'ACTIVE' })}
              />
            )}
          </>
        }
        tabs={TABS.map(([key, label]) => ({ key, label, children: body[key] }))}
        activeTab={tab}
        onTabChange={setTab}
      />
    </div>
  )
}
