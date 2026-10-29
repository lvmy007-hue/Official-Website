import { useState } from 'react'
import { Alert, DatePicker, Space, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { AuditOptionsResponse, PiiViewListResponse, PiiViewRow } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { PAGE_SIZES, Pager } from '../reimbursements/reimbursements-ui'
import { ActorText, Pick, SearchBox, rangeParams, type TimeRange } from './audit-ui'

// 个人信息明文查看（09 章 9.11 CR-096 补充）：谁、什么时候、出于什么理由、查看了哪个对象的哪些字段、访问模式。
// 数据来自查看买家信息明文时写的审计；这里只显示看了哪些字段的名称，不显示也不保存任何买家信息内容。
// 没有记录字段名的旧记录写“未记录字段”，被拒绝与没有内容可看的也都列出，方便核对。

const OUTCOME_COLOR: Record<string, string> = { OK: 'success', DENIED: 'warning' }

const columns: ColumnsType<PiiViewRow> = [
  { title: '时间', key: 'time', width: 160, render: (_value, row) => timeText(row.occurredAt) },
  { title: '查看人', key: 'actor', width: 130, render: (_value, row) => <ActorText actor={row.actor} /> },
  { title: '理由', key: 'reason', width: 240, render: (_value, row) => row.reason ?? <Muted>未填写</Muted> },
  {
    title: '查看对象',
    key: 'object',
    width: 220,
    render: (_value, row) => (
      <div>
        <div>{row.object.typeLabel}</div>
        <div style={{ fontSize: 12 }}>
          {row.object.path ? (
            <AppLink to={row.object.path} keepScope={false}>
              {row.object.label}
            </AppLink>
          ) : (
            <span className="erp-num">{row.object.label}</span>
          )}
        </div>
      </div>
    ),
  },
  {
    title: '查看的字段',
    key: 'fields',
    width: 240,
    render: (_value, row) =>
      row.outcome !== 'OK' ? (
        <Muted>没有返回内容</Muted>
      ) : row.fields === null ? (
        <Muted>未记录字段（早期记录）</Muted>
      ) : row.fields.length === 0 ? (
        <Muted>订单上没有可看的买家信息</Muted>
      ) : (
        <Space size={[4, 4]} wrap>
          {row.fields.map(field => (
            <Tag key={field} bordered={false}>
              {field}
            </Tag>
          ))}
        </Space>
      ),
  },
  {
    title: '结果',
    key: 'outcome',
    width: 180,
    render: (_value, row) => (
      <Tag color={OUTCOME_COLOR[row.outcome] ?? 'default'} bordered={false}>
        {row.outcomeLabel}
      </Tag>
    ),
  },
  { title: '访问模式', dataIndex: 'accessModeLabel', key: 'mode', width: 110 },
  {
    title: '操作',
    key: 'open',
    width: 90,
    fixed: 'right',
    render: (_value, row) => (
      <AppLink to={`/app/audit/${encodeURIComponent(row.id)}`} keepScope={false}>
        查看详情
      </AppLink>
    ),
  },
]

function Summary({ data }: { data: PiiViewListResponse | undefined }) {
  if (!data) return null
  const rule = data.alertRule
  return (
    <div data-testid="pii-summary" style={{ marginBottom: 8 }}>
      <Space size={24} wrap>
        <span>
          近 24 小时查看明文 <span className="erp-num">{data.summary.last24h}</span> 次
        </span>
        <span>
          近 7 天 <span className="erp-num">{data.summary.last7d}</span> 次
        </span>
        <span>
          近 7 天查看最多：
          {data.summary.topViewers.length === 0 ? (
            <Muted>尚无记录</Muted>
          ) : (
            data.summary.topViewers.map((viewer, index) => (
              <span key={viewer.actorId ?? `n${index}`}>
                {index > 0 ? '、' : ''}
                {viewer.name}（{viewer.count} 次）
              </span>
            ))
          )}
        </span>
      </Space>
      <div style={{ marginTop: 4 }}>
        {rule === null ? (
          <Muted>大量查看预警规则还没有补进企业（后台下一次预警评估时自动补入）。</Muted>
        ) : (
          <span>
            大量查看预警：{rule.enabled ? '已开启' : '已关闭'}，同一个人 {rule.windowMinutes} 分钟内成功查看明文达到 {rule.maxViews} 次时提醒，阈值可在{' '}
            <AppLink to="/app/alerts/rules" keepScope={false}>
              预警规则配置
            </AppLink>{' '}
            里调整。
          </span>
        )}
      </div>
    </div>
  )
}

export function PiiViewsTab({ initialActorId }: { initialActorId?: string }) {
  const [actorId, setActorId] = useState(initialActorId)
  const [q, setQ] = useState<string>()
  const [range, setRange] = useState<TimeRange>(null)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const options = useApiQuery<AuditOptionsResponse>({ domain: 'list', path: '/audit/options', scoped: false })
  const list = useApiQuery<PiiViewListResponse>({ domain: 'list', path: '/audit/pii-views', scoped: false, params: { actorId, q, ...rangeParams(range), pageSize, cursor: stack[stack.length - 1] } })
  const data = list.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const filtered = Boolean(actorId || q || range?.[0] || range?.[1])
  const actors = options.data?.actors ?? []
  // 从预警跳转来的查看人可能不在近 90 天的候选里（候选只列近期出现过的人）：补一项，保证筛选框显示得出来
  const actorOptions =
    actorId && !actors.some(item => item.value === actorId) ? [...actors, { value: actorId, label: data?.items.find(row => row.actor.id === actorId)?.actor.name ?? actorId }] : actors

  return (
    <div>
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message="这里只记录谁看了买家信息的哪些字段，不保存也不显示买家信息本身。买家信息在发货约 30 天后由系统清除。" />
      <Summary data={data} />
      <Space wrap style={{ marginBottom: 8 }}>
        <Pick
          label="查看人"
          value={actorId}
          options={actorOptions}
          onChange={value => {
            setActorId(value)
            reset()
          }}
        />
        <SearchBox
          width={280}
          label="搜索查看对象"
          placeholder="搜索订单号或订单编号"
          onSearch={value => {
            setQ(value)
            reset()
          }}
        />
        <DatePicker.RangePicker
          showTime
          aria-label="时间范围"
          value={range}
          onChange={value => {
            setRange(value)
            reset()
          }}
        />
        <Pick
          label="每页条数"
          value={String(pageSize)}
          options={PAGE_SIZES.map(size => ({ value: String(size), label: `${size} 条/页` }))}
          onChange={value => {
            setPageSize(Number(value ?? PAGE_SIZES[0]))
            reset()
          }}
          width={110}
        />
      </Space>
      <SimpleGrid<PiiViewRow>
        gridId="audit.pii-views-tab"
        columns={columns}
        rows={data?.items}
        rowKey={row => row.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyState={{ kind: 'empty', domain: '明文查看记录', prerequisite: filtered ? '没有符合条件的查看记录；可以放宽筛选条件或扩大时间范围。' : '尚无记录：还没有人查看过买家信息明文。' }}
      />
      <Pager stack={stack} next={next} busy={list.isFetching} onStack={setStack} />
    </div>
  )
}
