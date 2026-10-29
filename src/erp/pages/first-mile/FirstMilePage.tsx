import { useCallback, useState } from 'react'
import { permissionDeniedMessage } from '@nova/api-contracts'
import { Button, Card, Checkbox, Input, Select, Space, Tabs, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { DEVIATION_DEFAULT_PCT, FIRST_MILE_MODE_LABEL, FIRST_MILE_MODES, FIRST_MILE_STAGE_LABEL, FIRST_MILE_STAGES, type FirstMileListResponse, type FirstMileRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { PageHeader, SimplePagedGrid, type PageFetcher } from '../../components'
import { formatDate } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { buildPath, useApiQuery } from '../../query/api-query'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'
import { count, money } from '../procurement/procurement-ui'
import { ForwardersPanel } from './ForwardersPanel'
import { delayText, StageTag } from './first-mile-ui'
import { ShipmentDrawer } from './ShipmentDrawer'
import { TransitPanel } from './TransitPanel'

// 头程物流（P2a-11，06 章 6.10）：运单列表、货代、实际时效三个视图。
// 预估与实际费用需要字段权限 field.cost（没有权限整列不显示）；没有数据显示“尚无记录”，不是 0。

const date = (value: string | null) => (value ? formatDate(value) : <Muted>未填写</Muted>)

function Shipments() {
  const { canPermission } = useSession()
  const [q, setQ] = useState('')
  const [stage, setStage] = useState<string | undefined>()
  const [mode, setMode] = useState<string | undefined>()
  const [forwarderId, setForwarderId] = useState<string | undefined>()
  const [version, setVersion] = useState(0)
  const [open, setOpen] = useState(false)
  const [abnormal, setAbnormal] = useState(false)
  const withCost = canPermission('field.cost')
  // 货代下拉的选项取自列表响应；运单行由表格按页码另取。
  const list = useApiQuery<FirstMileListResponse>({ domain: 'list', path: '/first-mile', params: { page: 1, pageSize: 1 }, scoped: false })
  const deviation = abnormal && withCost
  const fetchPage = useCallback<PageFetcher<FirstMileRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<FirstMileListResponse>(
        buildPath('/first-mile', {
          q: q || undefined,
          stage,
          mode,
          forwarderId,
          deviation: deviation ? '1' : undefined,
          deviationPct: deviation ? String(DEVIATION_DEFAULT_PCT) : undefined,
          page,
          pageSize,
        }),
        { signal },
      )
      return { items: response.items, total: response.total }
    },
    [q, stage, mode, forwarderId, deviation],
  )
  const canWrite = canPermission('firstmile.write')

  const columns: ColumnsType<FirstMileRow> = [
    { title: '运单号', dataIndex: 'waybillNo', width: 170, render: (value: string, row) => <AppLink to={`/app/first-mile/${encodeURIComponent(row.id)}`}>{value}</AppLink> },
    { title: '货代', dataIndex: 'forwarderName', width: 140 },
    { title: '运输方式', dataIndex: 'modeLabel', width: 90 },
    { title: '柜号', dataIndex: 'containerNo', width: 120, render: (value: string | null) => value ?? <Muted>未填写</Muted> },
    { title: '阶段', dataIndex: 'stage', width: 90, render: (_value, row) => <StageTag stage={row.stage} /> },
    { title: '发货日', dataIndex: 'shipDate', width: 110, render: date },
    { title: '预计到港', dataIndex: 'etaPort', width: 110, render: date },
    { title: '实际到港', dataIndex: 'ataPort', width: 110, render: date },
    { title: '清关', dataIndex: 'customsLabel', width: 90 },
    { title: '预计交付', dataIndex: 'etaDelivery', width: 110, render: date },
    { title: '实际交付', dataIndex: 'ataDelivery', width: 110, render: date },
    { title: '时效', key: 'delay', width: 110, render: (_value, row) => delayText(row) },
    ...(withCost
      ? ([
          { title: '预估费用', key: 'estimated', width: 130, align: 'right', render: (_value, row) => money(row.estimatedCost, row.currency) },
          { title: '实际费用', key: 'actual', width: 130, align: 'right', render: (_value, row) => money(row.actualCost, row.currency) },
          {
            title: '预估偏差',
            key: 'deviation',
            width: 110,
            align: 'right',
            render: (_value, row) =>
              row.deviationPct === undefined || row.deviationPct === null ? (
                <Muted>尚无记录</Muted>
              ) : Math.abs(row.deviationPct) >= DEVIATION_DEFAULT_PCT ? (
                <Tag color="error">{row.deviationPct}%</Tag>
              ) : (
                <span className="erp-num">{row.deviationPct}%</span>
              ),
          },
        ] as ColumnsType<FirstMileRow>)
      : []),
    { title: '物流渠道', dataIndex: 'carrierChannelName', width: 170, render: (value: string | null) => value ?? <Muted>未选择</Muted> },
    { title: 'SKU 数', dataIndex: 'itemCount', width: 80, align: 'right', render: count },
    { title: '总数量', dataIndex: 'totalQty', width: 90, align: 'right', render: count },
    {
      title: '入仓货件',
      dataIndex: 'linkedInboundShipmentIds',
      width: 180,
      render: (value: string[]) => (value.length ? value.join('、') : <Muted>未关联</Muted>),
    },
  ]

  return (
    <Card size="small">
      <Space wrap style={{ marginBottom: 8 }}>
        <Tooltip title={canWrite ? undefined : permissionDeniedMessage('firstmile.write')}>
          <span>
            <Button type="primary" disabled={!canWrite} onClick={() => setOpen(true)}>
              新建运单
            </Button>
          </span>
        </Tooltip>
        <Input.Search
          allowClear
          style={{ width: 260 }}
          placeholder="搜索运单号、柜号、SKU"
          aria-label="搜索"
          onSearch={value => {
            setQ(value.trim())
          }}
        />
        {withCost ? (
          <Checkbox
            checked={abnormal}
            onChange={event => {
              setAbnormal(event.target.checked)
            }}
          >
            只看异常单（预估偏差 ≥ {DEVIATION_DEFAULT_PCT}%）
          </Checkbox>
        ) : null}
        <Select
          allowClear
          style={{ width: 150 }}
          placeholder="全部货代"
          aria-label="货代筛选"
          value={forwarderId}
          options={(list.data?.forwarders ?? []).map(row => ({ value: row.id, label: row.name }))}
          onChange={value => {
            setForwarderId(value)
          }}
        />
        <Select
          allowClear
          style={{ width: 130 }}
          placeholder="运输方式"
          aria-label="运输方式筛选"
          value={mode}
          options={FIRST_MILE_MODES.map(value => ({ value, label: FIRST_MILE_MODE_LABEL[value] }))}
          onChange={value => {
            setMode(value)
          }}
        />
        <Select
          allowClear
          style={{ width: 130 }}
          placeholder="全部阶段"
          aria-label="阶段筛选"
          value={stage}
          options={FIRST_MILE_STAGES.map(value => ({ value, label: FIRST_MILE_STAGE_LABEL[value] }))}
          onChange={value => {
            setStage(value)
          }}
        />
      </Space>
      <SimplePagedGrid<FirstMileRow>
        gridId="first-mile.shipments"
        columns={columns}
        fetchPage={fetchPage}
        rowKey={row => row.id}
        resetKey={JSON.stringify([q, stage, mode, forwarderId, deviation, withCost, version])}
        emptyState={{ kind: 'empty', domain: '头程运单', prerequisite: '还没有头程运单。先在“货代”里建立货代，再点“新建运单”录入发货信息。' }}
      />
      <ShipmentDrawer open={open} onClose={() => (setOpen(false), setVersion(current => current + 1))} />
    </Card>
  )
}

export default function FirstMilePage() {
  return (
    <div>
      <PageHeader
        actions={<AppLink to="/app/first-mile/carriers">物流渠道与报价</AppLink>}
        title="头程物流"
        description="国内仓到亚马逊仓之间的运输：货代、运单、节点、费用与分摊。实际时效按发货日到实际交付日统计，可人工确认后回写补货策略。"
      />
      <Tabs
        items={[
          { key: 'shipments', label: '运单', children: <Shipments /> },
          {
            key: 'transit',
            label: '实际时效',
            children: (
              <Card size="small">
                <TransitPanel />
              </Card>
            ),
          },
          {
            key: 'forwarders',
            label: '货代',
            children: (
              <Card size="small">
                <ForwardersPanel />
              </Card>
            ),
          },
        ]}
      />
    </div>
  )
}
