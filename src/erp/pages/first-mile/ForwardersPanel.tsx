import { Form, Input, Select, Space, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { FIRST_MILE_MODE_LABEL, FIRST_MILE_MODES, type ForwarderListResponse, type ForwarderRow } from '@nova/api-contracts'
import { FormAction, SimpleGrid } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { count, optional } from '../procurement/procurement-ui'

// 货代资料：名称、联系方式、常用运输方式。名称在企业内不能重复；停用后不能再用它新建运单，历史运单与时效统计都保留。

const WRITE = 'firstmile.write'
const modeOptions = FIRST_MILE_MODES.map(value => ({ value, label: FIRST_MILE_MODE_LABEL[value] }))

function Fields() {
  return (
    <>
      <Form.Item label="名称" name="name" rules={[{ required: true, whitespace: true, message: '请填写货代名称' }]}>
        <Input aria-label="名称" maxLength={120} />
      </Form.Item>
      <Form.Item label="联系方式（选填）" name="contact">
        <Input aria-label="联系方式" maxLength={200} />
      </Form.Item>
      <Form.Item label="常用运输方式（选填）" name="defaultMode">
        <Select aria-label="常用运输方式" allowClear options={modeOptions} style={{ width: 160 }} />
      </Form.Item>
    </>
  )
}

const bodyOf = (values: Record<string, unknown>) => ({ name: optional(values.name), contact: optional(values.contact) ?? null, defaultMode: optional(values.defaultMode) ?? null })

export function ForwardersPanel() {
  const list = useApiQuery<ForwarderListResponse>({ domain: 'list', path: '/freight-forwarders', params: { pageSize: 200 }, scoped: false })
  const create = useApiMutation<Record<string, unknown>, ForwarderRow>({ method: 'POST', path: '/freight-forwarders', invalidate: ['list', 'reference'], silent: true })
  const update = useApiMutation<{ id: string; body: Record<string, unknown> }, ForwarderRow>({
    method: 'PATCH',
    path: call => `/freight-forwarders/${encodeURIComponent(call.id)}`,
    body: call => call.body,
    invalidate: ['list', 'reference'],
    silent: true,
  })

  const columns: ColumnsType<ForwarderRow> = [
    { title: '名称', dataIndex: 'name', width: 220 },
    { title: '联系方式', dataIndex: 'contact', width: 220, render: (value: string | null) => value ?? <Muted>未填写</Muted> },
    { title: '常用运输方式', dataIndex: 'defaultMode', width: 130, render: (value: ForwarderRow['defaultMode']) => (value ? FIRST_MILE_MODE_LABEL[value] : <Muted>未设置</Muted>) },
    { title: '运单数', dataIndex: 'shipmentCount', width: 90, align: 'right', render: count },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: string) => (
        <Tag bordered={false} color={value === 'ACTIVE' ? 'success' : 'default'}>
          {value === 'ACTIVE' ? '合作中' : '已停用'}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'op',
      width: 160,
      render: (_value, row) => (
        <Space size={4}>
          <FormAction
            label="编辑"
            buttonProps={{ type: 'link', size: 'small' }}
            guard={{ permission: WRITE }}
            title={`编辑货代：${row.name}`}
            initialValues={{ name: row.name, contact: row.contact ?? '', defaultMode: row.defaultMode ?? undefined }}
            okText="保存"
            successText="已保存"
            onSubmit={values => update.mutateAsync({ id: row.id, body: { ...bodyOf(values), version: row.version } })}
          >
            <Fields />
          </FormAction>
          <FormAction
            label={row.status === 'ACTIVE' ? '停用' : '恢复合作'}
            danger={row.status === 'ACTIVE'}
            buttonProps={{ type: 'link', size: 'small' }}
            guard={{ permission: WRITE }}
            title={row.status === 'ACTIVE' ? `停用货代：${row.name}` : `恢复合作：${row.name}`}
            description={row.status === 'ACTIVE' ? '停用后不能再用它新建运单；历史运单与时效统计都保留。' : undefined}
            okText={row.status === 'ACTIVE' ? '停用' : '恢复'}
            successText={row.status === 'ACTIVE' ? '已停用' : '已恢复合作'}
            onSubmit={() => update.mutateAsync({ id: row.id, body: { version: row.version, status: row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' } })}
          />
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <FormAction
          label="新增货代"
          guard={{ permission: WRITE }}
          title="新增货代"
          okText="创建"
          successText="货代已创建"
          buttonProps={{ type: 'primary' }}
          onSubmit={values => create.mutateAsync(bodyOf(values))}
        >
          <Fields />
        </FormAction>
      </Space>
      <SimpleGrid<ForwarderRow>
        gridId="first-mile.forwarders-panel"
        columns={columns}
        rows={list.data?.items}
        rowKey={row => row.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyState={{ kind: 'empty', domain: '货代', prerequisite: '还没有货代。点“新增货代”建立第一个；新建运单必须选择货代。' }}
      />
    </div>
  )
}
