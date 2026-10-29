import { useCallback, useState } from 'react'
import { Card, Input, Select, Space, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { type LegalEntityListResponse, type LegalEntityRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PageHeader, SimplePagedGrid, type PageFetcher } from '../../components'
import { formatDate } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { buildPath, useApiMutation } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { EntityFields, EntityStatusTag, countText, createBody, statusOptions } from './entities-ui'

// 法律主体列表（P5-07，09 章 9.9；骨架：列表页）：主体名称、注册地、注册号、状态、店铺数、广告账户数。
// 店铺数与广告账户数只统计当前账号数据范围内的；广告账户数是绑定在名下店铺上的广告账户，没有绑定店铺的不属于任何主体。

const columns: ColumnsType<LegalEntityRow> = [
  { title: '主体名称', dataIndex: 'name', width: 260, render: (value: string, row) => <AppLink to={`/app/entities/${encodeURIComponent(row.id)}`}>{value}</AppLink> },
  { title: '注册地', dataIndex: 'registeredCountry', width: 160 },
  { title: '注册号', dataIndex: 'registrationNo', width: 200, render: (value: string | null) => value ?? <Muted>未填写</Muted> },
  { title: '状态', dataIndex: 'status', width: 100, render: (value: string) => <EntityStatusTag status={value} /> },
  { title: '店铺数', dataIndex: 'storeCount', width: 90, align: 'right', render: (value: number) => countText(value) },
  { title: '广告账户数', dataIndex: 'adsAccountCount', width: 110, align: 'right', render: (value: number) => countText(value) },
  { title: '创建时间', dataIndex: 'createdAt', width: 120, render: (value: string) => formatDate(value) },
]

export default function EntitiesPage() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<string | undefined>()
  const [version, setVersion] = useState(0)
  const [data, setData] = useState<LegalEntityListResponse | null>(null)
  const fetchPage = useCallback<PageFetcher<LegalEntityRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<LegalEntityListResponse>(buildPath('/entities', { q: q || undefined, status, page, pageSize }), { signal })
      setData(response)
      return { items: response.items, total: response.total }
    },
    [q, status],
  )
  const create = useApiMutation<Record<string, unknown>, LegalEntityRow>({ method: 'POST', path: '/entities', invalidate: ['list', 'reference'], silent: true })
  return (
    <div>
      <PageHeader title="法律主体" description="运营店铺的公司或个体。每个店铺都挂在某个法律主体名下；成员的数据范围可以按主体授权。" />
      <Card size="small">
        <Space wrap style={{ marginBottom: 8 }}>
          <FormAction
            label="新增法律主体"
            guard={{ permission: 'entity.write' }}
            title="新增法律主体"
            okText="创建"
            successText="法律主体已创建"
            buttonProps={{ type: 'primary' }}
            onSubmit={async values => {
              await create.mutateAsync(createBody(values))
              setVersion(current => current + 1)
            }}
          >
            <EntityFields />
          </FormAction>
          <Input.Search
            allowClear
            style={{ width: 280 }}
            placeholder="搜索名称、注册地、注册号"
            aria-label="搜索"
            onSearch={value => {
              setQ(value.trim())
            }}
          />
          <Select
            allowClear
            style={{ width: 140 }}
            placeholder="全部状态"
            aria-label="状态筛选"
            value={status}
            options={statusOptions}
            onChange={value => {
              setStatus(value)
            }}
          />
          {data ? (
            <Typography.Text type="secondary">
              共 {data.summary.total} 个主体：使用中 {data.summary.active}，已停用 {data.summary.inactive}
            </Typography.Text>
          ) : null}
        </Space>
        {data && !data.canWrite && data.writeBlockedReason ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            当前账号只能查看：{data.writeBlockedReason}
          </Typography.Paragraph>
        ) : null}
        <SimplePagedGrid<LegalEntityRow>
          gridId="entities.list"
          columns={columns}
          fetchPage={fetchPage}
          rowKey={row => row.id}
          resetKey={JSON.stringify([q, status, version])}
          emptyState={{
            kind: 'empty',
            domain: '法律主体',
            prerequisite: q || status ? '没有符合条件的法律主体，调整搜索词或状态后再试。' : '还没有法律主体。点“新增法律主体”登记运营店铺的公司或个体，再去“连接中心”授权店铺。',
          }}
        />
      </Card>
    </div>
  )
}
