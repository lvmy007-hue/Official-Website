import { useRef, useState } from 'react'
import { Alert, Select, Space, Typography } from 'antd'
import {
  REVIEWS_GROWTH_BASIS,
  REVIEWS_LIMITS,
  REVIEWS_SOLICIT,
  SOLICITATION_SWITCH_KEY,
  type CursorPageInfo,
  type EligibleOrderRow,
  type RatingGrowthRow,
  type SolicitCoverage,
  type SolicitSwitchState,
  type SolicitTabResponse,
  type SolicitationBatchResult,
} from '@nova/api-contracts'
import { ActionGuard, FreshnessBar, SimpleGrid } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { useSession } from '../../session/session'
import { coverageColumns, eligibleColumns, growthColumns, recentColumns, type RecentRequest } from './reviews-columns'
import { BATCH_MAX, batchIssue, solicitResultText, type SelectionProps } from './reviews-state'
import { Basis, Pager, SectionNote } from './reviews-ui'

// 请求评价（P4-13，05 章 5.7）：可请求订单（送达后第 5 至 30 天、尚未请求或上次发送失败）、批量请求（受写入开关控制，每单只请求一次，写审计）、请求覆盖率、请求后评分数增长。
// 不显示任何买家信息；没有数据写“尚无记录”，没有权限写“无权限”，不补 0。
// 第一页来自页签响应，翻页调用 /reviews/solicitations/eligible（游标），页码是游标栈的深度。

type EligiblePage = { items: EligibleOrderRow[]; pageInfo: CursorPageInfo }
const sameRows = (a: readonly EligibleOrderRow[], b: readonly EligibleOrderRow[]) =>
  a.length === b.length && a.every((row, index) => row.storeId === b[index]?.storeId && row.amazonOrderId === b[index]?.amazonOrderId)
type View = { storeId: string | undefined; stack: Array<string | undefined>; selected: EligibleOrderRow[] }

export function SolicitPanel({ storeId, onSelect }: SelectionProps) {
  const { canPermission } = useSession()
  const [view, setView] = useState<View>({ storeId, stack: [undefined], selected: [] })
  const [result, setResult] = useState<SolicitationBatchResult | null>(null)
  // 地址栏里的店铺变了（选择、后退）：翻页与已选行一并重置
  const current: View = view.storeId === storeId ? view : { storeId, stack: [undefined], selected: [] }
  const cursor = current.stack[current.stack.length - 1]
  const reset = () => setView({ storeId, stack: [undefined], selected: [] })

  const query = useApiQuery<SolicitTabResponse>({ domain: 'list', path: '/reviews', params: { tab: 'solicit', storeId } })
  const data = query.data
  const last = useRef<SolicitTabResponse>()
  if (data) last.current = data
  const shell = data ?? last.current
  const more = useApiQuery<EligiblePage>({
    domain: 'list',
    path: '/reviews/solicitations/eligible',
    params: { storeId, sort: 'deliveredAt:asc', pageSize: data?.pageInfo.pageSize, cursor },
    enabled: Boolean(cursor && data),
  })
  const page: EligiblePage | undefined = cursor ? more.data : data
  const busy = cursor ? more.isFetching : query.isFetching
  const next = page?.pageInfo.hasMore ? page.pageInfo.nextCursor : null

  const batch = useApiMutation<{ storeId: string; orderIds: string[] }, SolicitationBatchResult>({ method: 'POST', path: '/reviews/solicitations', invalidate: ['list'], silent: true })
  const permitted = canPermission(REVIEWS_SOLICIT)
  // 契约里有 SolicitSwitchState，但页签响应还没带上它：有就按它禁用并写原因，没有就由服务端在提交时拒绝并说明原因
  const sw = (data as (SolicitTabResponse & { switch?: SolicitSwitchState }) | undefined)?.switch
  const swOff = sw !== undefined && !sw.enabled
  const issue = batchIssue(current.selected)
  const target = current.selected[0]

  return (
    <div data-testid="solicit-panel">
      <FreshnessBar freshness={null} />
      <SectionNote state={shell?.state ?? 'OK'} note={shell?.note ?? null} />
      <div data-testid="solicit-switch-note" style={{ marginBottom: 8 }}>
        {!permitted ? (
          <Alert type="warning" showIcon message={`无权限：批量请求评价需要“请求评价”权限（${REVIEWS_SOLICIT}），请联系企业管理员开通`} />
        ) : swOff ? (
          <Alert type="warning" showIcon message={`写入开关“请求评价”（${SOLICITATION_SWITCH_KEY}）未开启：开关关闭时不会向亚马逊发出请求`} />
        ) : (
          <Alert type="info" showIcon message={`批量请求受写入开关“请求评价”（${SOLICITATION_SWITCH_KEY}）控制；开关关闭时服务端会拒绝并说明原因。每个订单只能请求一次。`} />
        )}
      </div>
      <Typography.Title level={5}>请求覆盖率（近 {REVIEWS_LIMITS.coverageDays} 天）</Typography.Title>
      <SimpleGrid<SolicitCoverage>
        gridId="reviews.solicit-panel"
        columns={coverageColumns}
        rows={shell?.coverage}
        rowKey={row => row.storeId}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '请求覆盖率', prerequisite: '还没有接入店铺或没有已送达的订单。' }}
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        请求后评分数增长
      </Typography.Title>
      <SimpleGrid<RatingGrowthRow>
        gridId="reviews.solicit-panel-2"
        columns={growthColumns}
        rows={shell?.growth}
        rowKey={row => `${row.storeId}|${row.asin}`}
        loading={query.isFetching}
        emptyState={{ kind: 'empty', domain: '请求后评分数增长', prerequisite: '还没有请求过评价；请求后再导入评分文件，才能对照前后的评分数。' }}
      />
      {shell ? <Basis>{shell.growthBasis || REVIEWS_GROWTH_BASIS}</Basis> : null}

      <Typography.Title level={5} style={{ marginTop: 24 }}>
        可请求订单
      </Typography.Title>
      <Space wrap style={{ marginBottom: 8 }}>
        <Select
          allowClear
          style={{ width: 220 }}
          placeholder="全部店铺"
          aria-label="请求评价店铺"
          value={storeId}
          virtual={false}
          options={(shell?.stores ?? []).map(store => ({ value: store.id, label: store.name }))}
          onChange={value => {
            onSelect({ storeId: value })
            reset()
          }}
        />
        <ActionGuard
          label="批量请求评价"
          guard={{ permission: REVIEWS_SOLICIT, ...(swOff ? { writeSwitch: { enabled: false } } : {}), condition: { ok: issue === null, reason: issue ?? undefined } }}
          buttonProps={{ type: 'primary' }}
          preview={{
            title: '确认批量请求评价',
            confirmText: '确认请求',
            content: (
              <div>
                <p>
                  将为店铺“{target?.storeName}”的 {current.selected.length} 个订单向亚马逊请求评价。
                </p>
                <p style={{ fontWeight: 600 }}>每个订单只能请求一次，提交后无法撤回。</p>
                <p style={{ margin: 0 }}>发送前会向亚马逊再查一次是否允许；不允许或已过期限的订单会被跳过，并说明原因。</p>
              </div>
            ),
          }}
          onExecute={async () => {
            if (!target) throw new Error('请先勾选要请求评价的订单')
            const done = await batch.mutateAsync({ storeId: target.storeId, orderIds: current.selected.map(row => row.amazonOrderId) })
            setResult(done)
            reset()
          }}
        />
        <span style={{ color: 'rgba(0,0,0,0.45)' }}>
          已勾选 {current.selected.length} 单（一次 1 到 {BATCH_MAX} 单，同一店铺）
        </span>
      </Space>
      {result ? (
        <Alert
          data-testid="solicit-result"
          closable
          onClose={() => setResult(null)}
          style={{ marginBottom: 8 }}
          type={result.accepted > 0 && result.skipped.length === 0 ? 'success' : 'warning'}
          showIcon
          message={solicitResultText(result)}
        />
      ) : null}
      {shell?.truncated ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="可请求的订单很多，只统计了最早送达的一部分；请求完这些后会出现更多" /> : null}
      <SimpleGrid<EligibleOrderRow>
        gridId="reviews.solicit-eligible"
        columns={eligibleColumns}
        rows={page?.items}
        rowKey={row => `${row.storeId}|${row.amazonOrderId}`}
        loading={busy}
        error={cursor ? more.error : query.error}
        onRetry={() => void (cursor ? more : query).refetch()}
        onSelectionChange={rows =>
          setView(latest => {
            const base: View = latest.storeId === storeId ? latest : { storeId, stack: [undefined], selected: [] }
            return sameRows(base.selected, rows) ? base : { ...base, selected: rows }
          })
        }
        emptyState={{ kind: 'empty', domain: '可请求订单', prerequisite: shell?.note ?? '没有处于送达后第 5 至 30 天、且尚未请求的订单。' }}
      />
      <Pager
        page={current.stack.length}
        hasNext={Boolean(next)}
        busy={busy}
        onPrev={() => setView({ ...current, stack: current.stack.slice(0, -1), selected: [] })}
        onNext={() => next && setView({ ...current, stack: [...current.stack, next], selected: [] })}
        note={page ? `本页 ${page.items.length} 单` : undefined}
      />

      <Typography.Title level={5} style={{ marginTop: 24 }}>
        最近请求记录
      </Typography.Title>
      <SimpleGrid<RecentRequest>
        gridId="reviews.solicit-panel-3"
        columns={recentColumns}
        rows={shell?.recent}
        rowKey={row => `${row.storeName}|${row.amazonOrderId}`}
        loading={query.isFetching}
        emptyState={{ kind: 'empty', domain: '请求记录', prerequisite: '还没有请求过评价。' }}
      />
      {shell ? <Basis>{shell.basis}</Basis> : null}
    </div>
  )
}
