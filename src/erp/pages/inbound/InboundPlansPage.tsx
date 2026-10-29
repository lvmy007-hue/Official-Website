import { useCallback, useMemo, useState } from 'react'
import { Alert, Button, Card, Input, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { INBOUND_STAGE_LABEL, type InboundException, type InboundPlanListResponse, type InboundPlanRow, type InboundStage } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { ActionGuard, FreshnessBar, PageHeader, SimplePagedGrid, type PageFetcher } from '../../components'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { buildPath, useApiQuery } from '../../query/api-query'
import type { ScopeOptions } from '../../shell/ScopeBar'
import { Muted } from '../inventory/inventory-ui'
import { InboundCreateDrawer } from './InboundCreateDrawer'
import { Countdown, DEADLINE_LABEL, inboundFreshnessInfo, inboundGuard, qty, SOURCE_LABEL, StageTag } from './inbound-ui'

// 入仓计划（P2a-12，06 章 6.11）：状态看板、异常队列、计划列表。
// 亚马逊侧的写操作都是异步的：计划上显示“处理中：某某操作”，直到亚马逊返回结果；调用亚马逊的动作要过“权限 → 连接 → 写入开关”，在详情页执行。
// 预处理与贴标固定由卖家负责（美国站亚马逊不再提供这两项服务）。

const EXCEPTION_LABEL: Record<InboundException['kind'], string> = { EXPIRING: '即将过期', OP_FAILED: '操作失败', DISCREPANCY: '接收差异' }

const columns: ColumnsType<InboundPlanRow> = [
  { title: '计划', dataIndex: 'name', width: 220, render: (value: string, row) => <AppLink to={`/app/supply-chain/${encodeURIComponent(row.id)}`}>{value}</AppLink> },
  { title: '店铺', dataIndex: 'storeName', width: 140 },
  { title: '亚马逊计划编号', dataIndex: 'externalPlanId', width: 180, render: (value: string | null) => value ?? <Muted>尚未提交</Muted> },
  { title: '状态', key: 'stage', width: 280, render: (_value, row) => <StageTag plan={row} /> },
  { title: 'SKU 数', dataIndex: 'skuCount', width: 80, align: 'right', render: qty },
  { title: '总件数', dataIndex: 'totalUnits', width: 90, align: 'right', render: qty },
  { title: '货件数', dataIndex: 'shipmentCount', width: 80, align: 'right', render: qty },
  { title: '来源', dataIndex: 'sourceType', width: 90, render: (value: string) => SOURCE_LABEL[value] ?? value },
  {
    title: '最近的截止时间',
    key: 'deadline',
    width: 230,
    render: (_value, row) =>
      row.nextDeadline ? (
        <span>
          {DEADLINE_LABEL[row.nextDeadline.kind]}：<Countdown at={row.nextDeadline.at} />
        </span>
      ) : (
        <Muted>无</Muted>
      ),
  },
  { title: '更新时间', dataIndex: 'updatedAt', width: 160, render: (value: string) => formatDateTime(value) },
]

function Board({ data, stage, onStage }: { data: InboundPlanListResponse | undefined; stage: InboundStage | undefined; onStage: (stage: InboundStage | undefined) => void }) {
  if (!data) return null
  return (
    <Space wrap size={[8, 8]} style={{ marginBottom: 8 }} data-testid="inbound-board" aria-label="状态看板">
      <Button size="small" type={stage ? 'default' : 'primary'} onClick={() => onStage(undefined)}>
        全部
      </Button>
      {data.board.map(item => (
        <Button key={item.stage} size="small" type={stage === item.stage ? 'primary' : 'default'} onClick={() => onStage(item.stage)}>
          {INBOUND_STAGE_LABEL[item.stage]} {item.count}
        </Button>
      ))}
    </Space>
  )
}

function Exceptions({ items }: { items: InboundException[] }) {
  if (items.length === 0) return null
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 8 }}
      message={`异常队列（${items.length}）`}
      data-testid="inbound-exceptions"
      description={
        <Space direction="vertical" size={2}>
          {items.map((item, index) => (
            <span key={`${item.planId}-${item.kind}-${index}`}>
              <Tag bordered={false} color={item.kind === 'OP_FAILED' ? 'error' : 'warning'}>
                {EXCEPTION_LABEL[item.kind]}
              </Tag>
              <AppLink to={`/app/supply-chain/${encodeURIComponent(item.planId)}`}>{item.planName}</AppLink>：{item.message}
              {item.kind === 'EXPIRING' && item.at ? (
                <>
                  {' '}
                  <Countdown at={item.at} />
                </>
              ) : null}
            </span>
          ))}
        </Space>
      }
    />
  )
}

export default function InboundPlansPage() {
  const [stage, setStage] = useState<InboundStage | undefined>()
  const [q, setQ] = useState('')
  const [text, setText] = useState('')
  const [version, setVersion] = useState(0)
  const [creating, setCreating] = useState(false)
  // 看板、异常队列与新鲜度取自列表响应（只取一行）；计划行由表格按页码另取。
  const list = useApiQuery<InboundPlanListResponse>({ domain: 'list', path: '/inbound/plans', params: { stage, q: q || undefined, page: 1, pageSize: 1 } })
  const fetchPage = useCallback<PageFetcher<InboundPlanRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<InboundPlanListResponse>(buildPath('/inbound/plans', { stage, q: q || undefined, page, pageSize }), { signal })
      return { items: response.items, total: response.total }
    },
    [stage, q],
  )
  const options = useApiQuery<ScopeOptions>({ domain: 'reference', path: '/scope/options', scoped: false })
  const stores = useMemo(() => (options.data?.stores ?? []).map(store => ({ id: store.id, name: store.name })), [options.data])
  const data = list.data

  return (
    <div>
      <PageHeader title="入仓计划" description="从资格预检到货件接收的完整入仓流程。亚马逊侧的每一步都是异步的，状态会一直显示到亚马逊返回结果；预处理与贴标固定由卖家负责。" />
      <Card size="small">
        <FreshnessBar freshness={inboundFreshnessInfo(data?.freshness)} />
        <Exceptions items={data?.exceptions ?? []} />
        <Board
          data={data}
          stage={stage}
          onStage={value => {
            setStage(value)
          }}
        />
        <Space wrap style={{ marginBottom: 8 }}>
          <ActionGuard label="新建入仓计划" guard={inboundGuard(data?.write, { amazon: false })} onExecute={async () => setCreating(true)} buttonProps={{ type: 'primary' }} />
          <Input.Search
            allowClear
            style={{ width: 280 }}
            placeholder="搜索计划名称、计划编号"
            aria-label="搜索"
            value={text}
            onChange={event => setText(event.target.value)}
            onSearch={value => {
              setQ(value.trim())
            }}
          />
          <Typography.Text type="secondary">新建只保存草稿；调用亚马逊的步骤在计划详情里执行。</Typography.Text>
        </Space>
        <SimplePagedGrid<InboundPlanRow>
          gridId="inbound-plans"
          columns={columns}
          fetchPage={fetchPage}
          rowKey={row => row.id}
          resetKey={JSON.stringify([stage, q, version])}
          emptyState={{ kind: 'empty', domain: '入仓计划', prerequisite: '还没有入仓计划。点击“新建入仓计划”，或在补货建议里生成入仓计划草稿；店铺授权后才能提交到亚马逊。' }}
        />
      </Card>
      <InboundCreateDrawer open={creating} onClose={() => (setCreating(false), setVersion(current => current + 1))} stores={stores} />
    </div>
  )
}
