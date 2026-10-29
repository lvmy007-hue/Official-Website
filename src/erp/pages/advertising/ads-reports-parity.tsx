import { useState } from 'react'
import { Alert, Button, Drawer, Space, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ADS_PARITY_CATEGORIES,
  ADS_PARITY_CATEGORY_LABEL,
  type AdsParityDiffRow,
  type AdsParityDiffsResponse,
  type AdsParityProfileRow,
  type AdsParityResponse,
  type AdsParityRunRow,
} from '@nova/api-contracts'
import { DataState, stateFromError, SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { ParityRunAction } from './ads-reports-actions'
import { PARITY_STATUS_COLOR, PARITY_STATUS_LABEL } from './ads-reports-data'

// 迁移期核对页签（08 章 8.12，CR-001）：新报告接口与旧版接口的数据逐日对照，差异分四类——时间口径、归因口径、范围、未解释。
// 只有“未解释”会阻止关闭旧通道；连续多次核对没有未解释差异后旧通道自动关闭。这里只读，除了“立即核对”只排任务。

const profileColumns = (onChanged: () => void): ColumnsType<AdsParityProfileRow> => [
  { title: '广告档案', key: 'name', render: (_value, row) => `${row.name}${row.storeName ? ` · ${row.storeName}` : ''}` },
  {
    title: '旧通道',
    key: 'legacy',
    width: 220,
    render: (_value, row) =>
      row.legacyEnabled ? (
        <Tag color="processing" bordered={false}>
          仍在使用
        </Tag>
      ) : (
        <span>
          <Tag bordered={false}>已关闭</Tag>
          <Muted>{row.closedReason ?? ''}</Muted>
        </span>
      ),
  },
  { title: '连续通过', key: 'passes', width: 110, render: (_value, row) => <span className="erp-num">{`${row.consecutivePasses} / ${row.requiredPasses}`}</span> },
  {
    title: '最近核对',
    key: 'last',
    width: 220,
    render: (_value, row) =>
      row.lastRunAt ? (
        <span>
          <span className="erp-num">{formatDateTime(row.lastRunAt)}</span>{' '}
          {row.lastStatus ? (
            <Tag color={PARITY_STATUS_COLOR[row.lastStatus]} bordered={false}>
              {PARITY_STATUS_LABEL[row.lastStatus]}
            </Tag>
          ) : null}
        </span>
      ) : (
        <Muted>尚未核对</Muted>
      ),
  },
  { title: '操作', key: 'actions', width: 110, render: (_value, row) => <ParityRunAction profileId={row.id} name={row.name} ready={row.adsAccountReady} onDone={onChanged} /> },
]

const runColumns = (onOpen: (row: AdsParityRunRow) => void): ColumnsType<AdsParityRunRow> => [
  { title: '时间', key: 'startedAt', width: 160, render: (_value, row) => <span className="erp-num">{formatDateTime(row.startedAt)}</span> },
  { title: '广告档案', key: 'profile', dataIndex: 'profileName', width: 160 },
  { title: '核对窗口', key: 'window', width: 190, render: (_value, row) => <span className="erp-num">{`${row.windowStart} 至 ${row.windowEnd}`}</span> },
  { title: '旧版 / 新版行数', key: 'counts', width: 140, render: (_value, row) => <span className="erp-num">{`${row.legacyCount} / ${row.newCount}`}</span> },
  { title: '一致', key: 'matched', dataIndex: 'matchedCount', width: 70, align: 'right' },
  {
    title: '差异',
    key: 'diffs',
    width: 330,
    render: (_value, row) =>
      ADS_PARITY_CATEGORIES.map(key => (
        <Tag key={key} color={key === 'UNEXPLAINED' && row.counts[key] > 0 ? 'error' : 'default'} bordered={false}>{`${ADS_PARITY_CATEGORY_LABEL[key]} ${row.counts[key]}`}</Tag>
      )),
  },
  {
    title: '结果',
    key: 'status',
    width: 120,
    render: (_value, row) => (
      <Tag color={PARITY_STATUS_COLOR[row.status]} bordered={false}>
        {PARITY_STATUS_LABEL[row.status]}
      </Tag>
    ),
  },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    fixed: 'right',
    render: (_value, row) => (
      <Button type="link" size="small" aria-label={`查看差异 ${row.profileName} ${row.windowEnd}`} onClick={() => onOpen(row)}>
        查看差异
      </Button>
    ),
  },
]

const diffColumns: ColumnsType<AdsParityDiffRow> = [
  {
    title: '类别',
    key: 'category',
    width: 90,
    render: (_value, row) => (
      <Tag color={row.category === 'UNEXPLAINED' ? 'error' : 'default'} bordered={false}>
        {ADS_PARITY_CATEGORY_LABEL[row.category]}
      </Tag>
    ),
  },
  { title: '对象', key: 'entityKey', dataIndex: 'entityKey', width: 200 },
  { title: '字段', key: 'field', dataIndex: 'field', width: 90 },
  { title: '旧版', key: 'legacyValue', width: 90, render: (_value, row) => (row.legacyValue === null ? <Muted>空</Muted> : <span className="erp-num">{row.legacyValue}</span>) },
  { title: '新版', key: 'newValue', width: 90, render: (_value, row) => (row.newValue === null ? <Muted>空</Muted> : <span className="erp-num">{row.newValue}</span>) },
  { title: '说明', key: 'explanation', dataIndex: 'explanation' },
]

function DiffDrawer({ run, onClose }: { run: AdsParityRunRow | null; onClose: () => void }) {
  const query = useApiQuery<AdsParityDiffsResponse>({ domain: 'list', path: `/ads/parity/${encodeURIComponent(run?.id ?? '')}/diffs`, enabled: Boolean(run), staleMs: 0 })
  const data = query.data
  return (
    <Drawer
      open={Boolean(run)}
      onClose={onClose}
      width={860}
      title={run ? `核对差异：${run.profileName}（${run.windowStart} 至 ${run.windowEnd}）` : '核对差异'}
      destroyOnClose
      data-testid="ads-parity-diffs"
    >
      {query.error ? <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} /> : null}
      {!data && !query.error ? <DataState kind="skeleton" rows={6} /> : null}
      {data ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          {data.truncated ? <Alert type="warning" showIcon message="差异行较多，只显示前面一部分（未解释的排在最前），各类别的总数见核对记录" /> : null}
          <SimpleGrid<AdsParityDiffRow>
            gridId="advertising.ads-reports-parity"
            columns={diffColumns}
            rows={data.items}
            rowKey={row => row.id}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '这次核对没有差异' }}
          />
        </Space>
      ) : null}
    </Drawer>
  )
}

export function ParityTab() {
  const query = useApiQuery<AdsParityResponse>({ domain: 'list', path: '/ads/parity', staleMs: 0 })
  const [opened, setOpened] = useState<AdsParityRunRow | null>(null)
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  const data = query.data
  if (!data) return <DataState kind="skeleton" rows={5} />
  return (
    <div data-testid="ads-reports-parity">
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.sunsetNote} data-testid="ads-parity-sunset" />
      {data.note ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={data.note} data-testid="ads-parity-note" /> : null}
      <SimpleGrid<AdsParityProfileRow>
        gridId="advertising.ads-reports-parity-2"
        columns={profileColumns(() => void query.refetch())}
        rows={data.profiles}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '还没有广告档案' }}
      />
      <SimpleGrid<AdsParityRunRow>
        gridId="advertising.ads-reports-parity-3"
        columns={runColumns(setOpened)}
        rows={data.runs}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无核对记录' }}
      />
      <DiffDrawer run={opened} onClose={() => setOpened(null)} />
    </div>
  )
}
