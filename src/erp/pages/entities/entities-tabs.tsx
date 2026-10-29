import { Descriptions, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CONNECTION_STATE_LABEL,
  ENTITY_ACCESS_LABEL,
  ADS_BINDING_STATUS_LABEL,
  ENTITY_ADS_ACCOUNT_LIMIT,
  ENTITY_CHANGE_LIMIT,
  ENTITY_MEMBER_LIMIT,
  ENTITY_MEMBERS_PERMISSION,
  ENTITY_STORE_LIMIT,
  type ConnectionState,
  type EntityAdsAccountView,
  type EntityChangeView,
  type EntityMemberView,
  type EntityStoreView,
  type LegalEntityDetail,
} from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { EntityStatusTag } from './entities-ui'

// 法律主体详情的四个页签内容：基本资料、名下店铺与广告账户、被授权成员、变更记录。没有数据的位置写“尚无记录”，没有权限的位置写缺哪个权限点。

const truncatedNote = (limit: number) => <Typography.Text type="secondary">只显示前 {limit} 条。</Typography.Text>

const storeColumns: ColumnsType<EntityStoreView> = [
  { title: '店铺', dataIndex: 'displayName', width: 220 },
  { title: '卖家编号', dataIndex: 'sellerId', width: 160 },
  { title: '区域', dataIndex: 'logicalRegion', width: 90 },
  {
    title: '卖家授权',
    dataIndex: 'connectionState',
    width: 120,
    render: (value: string | null) => (value ? (CONNECTION_STATE_LABEL[value as ConnectionState] ?? value) : <Muted>尚未授权</Muted>),
  },
]

const adsColumns: ColumnsType<EntityAdsAccountView> = [
  { title: '广告账户', dataIndex: 'displayName', width: 220 },
  { title: '档案编号', dataIndex: 'profileId', width: 160 },
  { title: '站点', dataIndex: 'countryCode', width: 80 },
  { title: '所属店铺', dataIndex: 'storeName', width: 180, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '绑定方式', dataIndex: 'bindingStatus', width: 120, render: (value: string) => ADS_BINDING_STATUS_LABEL[value as keyof typeof ADS_BINDING_STATUS_LABEL] ?? value },
]

const memberColumns: ColumnsType<EntityMemberView> = [
  { title: '成员', dataIndex: 'name', width: 180 },
  { title: '邮箱', dataIndex: 'email', width: 220 },
  { title: '角色', dataIndex: 'roleName', width: 140 },
  { title: '状态', dataIndex: 'status', width: 90, render: (value: string) => (value === 'ACTIVE' ? '正常' : '已停用') },
  {
    title: '数据范围',
    key: 'access',
    render: (_value, row) => (row.access === 'STORES' ? `${ENTITY_ACCESS_LABEL.STORES}：${row.storeNames.join('、')}` : ENTITY_ACCESS_LABEL[row.access]),
  },
]

const changeColumns: ColumnsType<EntityChangeView> = [
  { title: '时间', dataIndex: 'occurredAt', width: 170, render: (value: string) => formatDateTime(value) },
  { title: '操作人', dataIndex: 'actor', width: 160 },
  { title: '动作', dataIndex: 'actionLabel', width: 110 },
  {
    title: '变化',
    key: 'changes',
    render: (_value, row) =>
      row.changes.length ? (
        row.changes.map(item => (
          <div key={item.field}>
            {item.label}：{item.before ?? <Muted>空</Muted>} → {item.after ?? <Muted>空</Muted>}
          </div>
        ))
      ) : (
        <Muted>没有记录字段变化</Muted>
      ),
  },
  { title: '原因', dataIndex: 'reason', width: 220, render: (value: string | null) => value ?? <Muted>未填写</Muted> },
]

export function InfoTab({ detail }: { detail: LegalEntityDetail }) {
  const { entity } = detail
  return (
    <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
      <Descriptions.Item label="主体名称">{entity.name}</Descriptions.Item>
      <Descriptions.Item label="状态">
        <EntityStatusTag status={entity.status} />
      </Descriptions.Item>
      <Descriptions.Item label="注册地">{entity.registeredCountry}</Descriptions.Item>
      <Descriptions.Item label="注册号">{entity.registrationNo ?? <Muted>未填写</Muted>}</Descriptions.Item>
      <Descriptions.Item label="创建时间">{formatDateTime(entity.createdAt)}</Descriptions.Item>
      <Descriptions.Item label="最近修改">{formatDateTime(entity.updatedAt)}</Descriptions.Item>
    </Descriptions>
  )
}

export function AssetsTab({ detail }: { detail: LegalEntityDetail }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <Typography.Title level={5}>名下店铺</Typography.Title>
        <SimpleGrid<EntityStoreView>
          gridId="entities.entities-tabs"
          columns={storeColumns}
          rows={detail.stores}
          rowKey={row => row.id}
          emptyState={{ kind: 'empty', domain: '名下店铺', prerequisite: '这个主体名下还没有店铺。到“连接中心”授权店铺时选择本主体即可挂到名下。' }}
        />
        {detail.storesTruncated ? truncatedNote(ENTITY_STORE_LIMIT) : null}
      </div>
      <div>
        <Typography.Title level={5}>名下广告账户</Typography.Title>
        <SimpleGrid<EntityAdsAccountView>
          gridId="entities.entities-tabs-2"
          columns={adsColumns}
          rows={detail.adsAccounts}
          rowKey={row => row.id}
          emptyState={{ kind: 'empty', domain: '名下广告账户', prerequisite: '广告账户通过绑定店铺归到主体名下。到“连接中心”授权广告账户并绑定店铺后会出现在这里。' }}
        />
        {detail.adsAccountsTruncated ? truncatedNote(ENTITY_ADS_ACCOUNT_LIMIT) : null}
      </div>
    </div>
  )
}

export function MembersTab({ detail }: { detail: LegalEntityDetail }) {
  if (detail.members.state === 'RESTRICTED') {
    return <Muted>无权查看：需要“成员查看”权限（{ENTITY_MEMBERS_PERMISSION}），请管理员在“成员与角色”的角色编辑器里开通。</Muted>
  }
  return (
    <>
      <SimpleGrid<EntityMemberView>
        gridId="entities.entities-tabs-3"
        columns={memberColumns}
        rows={detail.members.items}
        rowKey={row => row.membershipId}
        emptyState={{ kind: 'empty', domain: '被授权成员', prerequisite: '还没有成员被授权访问这个主体。在“成员与角色”里给成员授权数据范围后会出现在这里。' }}
      />
      {detail.members.truncated ? truncatedNote(ENTITY_MEMBER_LIMIT) : null}
    </>
  )
}

export function ChangesTab({ detail }: { detail: LegalEntityDetail }) {
  return (
    <>
      <SimpleGrid<EntityChangeView>
        gridId="entities.entities-tabs-4"
        columns={changeColumns}
        rows={detail.changes}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '变更记录', prerequisite: '这个主体还没有登记过修改。新增、修改与停用都会记在这里，并写入审计。' }}
      />
      {detail.changes.length >= ENTITY_CHANGE_LIMIT ? truncatedNote(ENTITY_CHANGE_LIMIT) : null}
    </>
  )
}
