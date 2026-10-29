import { useCallback, useMemo, useState } from 'react'
import { Card, DatePicker, Select, Space, Typography } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import quarterOfYear from 'dayjs/plugin/quarterOfYear'
import { TARGET_PERIOD_KINDS, TARGET_PERIOD_KIND_LABEL, type TargetGridResponse, type TargetHistoryResponse, type TargetPeriodKind, type TargetRow } from '@nova/api-contracts'
import { DataState, EventTimeline, FormAction, PageHeader, SimpleGrid } from '../../components'
import type { ScopeOptions } from '../../shell/ScopeBar'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { EditTargetFields, gridColumns, historyEvents, NewCustomTargetFields, WRITE } from './targets-parts'

dayjs.extend(quarterOfYear)

// 目标与预算（P2a-04，04 章 4.4）：按店铺 × 期间设置目标，实际与目标节奏对照，变更历史。
// 这里要先选一个店铺——目标按店铺 × 期间保存，不是全局范围栏那种多选汇总。

function periodStartOf(kind: TargetPeriodKind, anchor: Dayjs): string {
  if (kind === 'YEAR') return anchor.startOf('year').format('YYYY-MM-DD')
  if (kind === 'QUARTER') return anchor.startOf('quarter').format('YYYY-MM-DD')
  return anchor.startOf('month').format('YYYY-MM-DD')
}

type UpsertVars = { dimension: string; dimensionRef: string; metric: string; targetValue: number; paceMode: string; note?: string; version: number }

export default function TargetsPage() {
  const scope = useApiQuery<ScopeOptions>({ domain: 'reference', path: '/scope/options', scoped: false })
  const stores = scope.data?.stores ?? []
  const [sellerAccountId, setSellerAccountId] = useState<string | undefined>(undefined)
  const [periodKind, setPeriodKind] = useState<TargetPeriodKind>('MONTH')
  const [anchor, setAnchor] = useState<Dayjs>(() => dayjs())
  const activeStore = sellerAccountId ?? stores[0]?.id

  const periodStart = periodStartOf(periodKind, anchor)
  const params = { sellerAccountId: activeStore, periodKind, periodStart }
  const grid = useApiQuery<TargetGridResponse>({ domain: 'config', path: '/targets', scoped: false, params, enabled: Boolean(activeStore) })
  const history = useApiQuery<TargetHistoryResponse>({ domain: 'config', path: '/targets/history', scoped: false, params, enabled: Boolean(activeStore) })

  const upsert = useApiMutation<UpsertVars, unknown>({
    method: 'PUT',
    path: '/targets',
    body: values => ({ sellerAccountId: activeStore, periodKind, periodStart, ...values }),
    invalidate: ['config'],
    silent: true,
  })
  const refresh = useCallback(() => {
    void grid.refetch()
    void history.refetch()
  }, [grid, history])

  const storeColumns = useMemo(() => gridColumns(row => editAction(row, upsert.mutateAsync, refresh), false), [upsert.mutateAsync, refresh])
  const customColumns = useMemo(() => gridColumns(row => editAction(row, upsert.mutateAsync, refresh), true), [upsert.mutateAsync, refresh])

  const actions = (
    <FormAction
      label="新增细化目标"
      guard={{ permission: WRITE }}
      title="新增细化目标（类目或 ASIN 组）"
      description="整店目标在下方网格里直接编辑；这里新增按类目或 ASIN 组细化的目标。"
      onSubmit={values =>
        upsert.mutateAsync({
          dimension: String(values.dimension),
          dimensionRef: String(values.dimensionRef),
          metric: String(values.metric),
          targetValue: Number(values.targetValue),
          paceMode: String(values.paceMode ?? 'LINEAR'),
          note: values.note ? String(values.note) : undefined,
          version: 0,
        })
      }
      successText="已新增细化目标"
      onDone={refresh}
    >
      <NewCustomTargetFields />
    </FormAction>
  )

  return (
    <div>
      <PageHeader title="目标与预算" description="按店铺 × 月份（也可按季、按年）设置目标；实际与目标节奏对照，预测本期能否达成。" actions={activeStore ? actions : undefined} />
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          style={{ width: 220 }}
          placeholder="选择店铺"
          loading={scope.isLoading}
          value={activeStore}
          options={stores.map(store => ({ value: store.id, label: store.name }))}
          onChange={setSellerAccountId}
          aria-label="目标店铺"
        />
        <Select
          style={{ width: 100 }}
          value={periodKind}
          options={TARGET_PERIOD_KINDS.map(value => ({ value, label: TARGET_PERIOD_KIND_LABEL[value] }))}
          onChange={setPeriodKind}
          aria-label="周期粒度"
        />
        <DatePicker
          picker={periodKind === 'MONTH' ? 'month' : periodKind === 'QUARTER' ? 'quarter' : 'year'}
          value={anchor}
          onChange={value => value && setAnchor(value)}
          allowClear={false}
          aria-label="期间"
        />
        {grid.data ? (
          <Typography.Text type="secondary">
            期间：{grid.data.periodStart} 至 {grid.data.periodEnd}
          </Typography.Text>
        ) : null}
      </Space>

      {!activeStore ? (
        <DataState kind="empty" domain="目标与预算" prerequisite="你还没有被授予任何店铺的数据访问范围，请联系企业管理员在“成员”里分配。" />
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Card size="small" title="整店目标">
            <SimpleGrid<TargetRow>
              gridId="targets.targets-page"
              columns={storeColumns}
              rows={grid.data?.storeRows}
              rowKey={row => row.metric}
              loading={grid.isPending}
              error={grid.error}
              onRetry={() => void grid.refetch()}
              emptyState={{ kind: 'empty', domain: '整店目标', prerequisite: '尚未设置过目标' }}
            />
          </Card>
          <Card size="small" title="细化目标（类目 / ASIN 组）">
            <SimpleGrid<TargetRow>
              gridId="targets.targets-page-2"
              columns={customColumns}
              rows={grid.data?.customRows}
              rowKey={row => `${row.dimension}:${row.dimensionRef}:${row.metric}`}
              loading={grid.isPending}
              error={grid.error}
              onRetry={() => void grid.refetch()}
              emptyState={{ kind: 'empty', domain: '细化目标', prerequisite: '还没有按类目或 ASIN 组设置过细化目标；点击右上角“新增细化目标”。' }}
            />
          </Card>
          <Card size="small" title="变更历史" data-testid="targets-history">
            {history.error ? (
              <DataState kind="server-error" onRetry={() => void history.refetch()} />
            ) : history.isPending ? (
              <DataState kind="skeleton" rows={3} />
            ) : (
              <EventTimeline events={historyEvents(history.data?.items ?? [])} />
            )}
          </Card>
        </Space>
      )}
    </div>
  )
}

function editAction(row: TargetRow, mutateAsync: (values: UpsertVars) => Promise<unknown>, onDone: () => void) {
  return (
    <FormAction
      label="编辑目标"
      guard={{ permission: WRITE }}
      title="编辑目标"
      initialValues={{ targetValue: row.targetValue ?? undefined, paceMode: row.paceMode, note: row.note ?? undefined }}
      onSubmit={values =>
        mutateAsync({
          dimension: row.dimension,
          dimensionRef: row.dimensionRef,
          metric: row.metric,
          targetValue: Number(values.targetValue),
          paceMode: String(values.paceMode ?? row.paceMode),
          note: values.note ? String(values.note) : undefined,
          version: row.version,
        })
      }
      successText="已保存目标"
      onDone={onDone}
      buttonProps={{ size: 'small' }}
    >
      <EditTargetFields row={row} />
    </FormAction>
  )
}
