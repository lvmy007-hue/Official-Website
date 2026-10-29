import { useCallback, useState } from 'react'
import { Card, Select, Space } from 'antd'
import { SETTLEMENT_STATUSES, SETTLEMENT_STATUS_LABEL, type SettlementListResponse, type SettlementRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FreshnessBar, MassiveGrid, PageHeader, type CursorFetcher } from '../../components'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { settlementColumns } from './settlements-columns'

// 结算交易（P2b-07，07 章 7.7；P6-28 迁到 MassiveGrid）：每张结算单一行，按打款日从新到旧；核对状态是“已对平 / 有差异 / 待核对”。
// 官方依据是亚马逊的结算报告（周期结束后才生成），三方核对 = 结算报告 × 财务接口交易 × 我方订单；报告没到或财务交易没到时是“待核对”，不显示差额。
// 金额是结算币种，不跨币种相加。服务端固定按打款日排序，没有可选排序字段。

const STATUS_OPTIONS = SETTLEMENT_STATUSES.map(value => ({ value, label: SETTLEMENT_STATUS_LABEL[value] }))

type Meta = Pick<SettlementListResponse, 'freshness' | 'summary' | 'note'>

export default function SettlementsPage() {
  const { apiParams } = useScope()
  const [status, setStatus] = useState<string | undefined>()
  const [meta, setMeta] = useState<Meta | null>(null)
  const fetchPage = useCallback<CursorFetcher<SettlementRow>>(
    async ({ cursor, limit, signal }) => {
      const data = await apiFetch<SettlementListResponse>(buildPath('/settlements', { ...apiParams, status, pageSize: limit, cursor: cursor ?? undefined }), { signal })
      setMeta({ freshness: data.freshness, summary: data.summary, note: data.note })
      return { items: data.items, nextCursor: data.pageInfo.hasMore ? data.pageInfo.nextCursor : null, approxTotal: data.pageInfo.approxTotal }
    },
    [apiParams, status],
  )

  return (
    <div>
      <PageHeader
        title="结算交易"
        description="按结算周期核对亚马逊的打款：结算报告是官方依据，与财务接口交易、我方订单三方核对，找出对不上的交易并归类（时间口径、归因口径、范围、未解释）。结算报告在周期结束后才由亚马逊生成。"
      />
      <Card size="small">
        <FreshnessBar freshness={meta?.freshness} />
        {meta ? (
          <p style={{ margin: '8px 0' }} data-testid="settlement-summary">
            共 <span className="erp-num">{meta.summary.total}</span> 张结算单：已对平 <span className="erp-num">{meta.summary.matched}</span>，有差异{' '}
            <span className="erp-num">{meta.summary.discrepancy}</span>，待核对 <span className="erp-num">{meta.summary.pending}</span>
          </p>
        ) : null}
        <Space wrap style={{ margin: '8px 0' }}>
          <Select allowClear style={{ width: 150 }} placeholder="核对状态" aria-label="核对状态" value={status} options={STATUS_OPTIONS} onChange={value => setStatus(value)} />
        </Space>
        <MassiveGrid<SettlementRow>
          gridId="finance.settlements"
          columns={settlementColumns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          resetKey={JSON.stringify([apiParams, status])}
          appliedFilterCount={status ? 1 : 0}
          emptyState={{ kind: 'empty', domain: '结算单', prerequisite: meta?.note ?? '尚无结算单。' }}
          height={560}
        />
      </Card>
    </div>
  )
}
