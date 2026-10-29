import { useCallback, useMemo } from 'react'
import { Space } from 'antd'
import type { Asin360CompareResponse, Asin360CompareRow } from '@nova/api-contracts'
import { DeltaText, PagedGrid, renderColumn, RIGHT_ALIGNED, type ErpColDef, type PageFetcher } from '../../components'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { QueryBody, useProductQuery } from './asin360-hooks'

// 同环比明细（P6-21，16 章 3.1 第 1 项）：通用结构 {metric, value, prevValue, changeRate, changeValue}，按共享筛选里选的对比方式取对比期。
// 没有取值的格子写原因（尚未接入、无权查看、尚无记录），不显示 0。表很短（9 个指标），用 PagedGrid 在本地分页，列与工具栏与全站一致。

const STATE_TEXT: Record<Asin360CompareRow['state'], string> = { OK: '', NO_DATA: '尚无记录', NOT_CONNECTED: '尚未接入', RESTRICTED: '无权查看' }

function valueText(row: Asin360CompareRow, value: number, currency: string, signed = false): string {
  if (row.format === 'money') return formatMoney(value, currency, { digits: 2 })
  if (row.format === 'percent') return formatPercent(value, { digits: 2, sign: signed })
  return formatNumber(value, { digits: 0, sign: signed })
}

function cell(row: Asin360CompareRow, value: number | null, currency: string, empty: string) {
  if (value === null) return <Muted>{empty}</Muted>
  return <span className="erp-num">{valueText(row, value, currency)}</span>
}

function changeValueText(row: Asin360CompareRow, currency: string) {
  if (row.changeValue === null) return <Muted>—</Muted>
  if (row.format === 'percent') return <span className="erp-num">{`${formatNumber(row.changeValue * 100, { digits: 2, sign: true })} 个百分点`}</span>
  if (row.format === 'money') return <span className="erp-num">{formatMoney(row.changeValue, currency, { digits: 2, sign: true })}</span>
  return <span className="erp-num">{formatNumber(row.changeValue, { digits: 0, sign: true })}</span>
}

function CompareGrid({ data }: { data: Asin360CompareResponse }) {
  const comparing = data.compare !== null
  const { currency } = data
  const columns = useMemo<ErpColDef<Asin360CompareRow>[]>(
    () => [
      renderColumn<Asin360CompareRow>('指标', 'label', row => row.label, { group: '指标', pin: 'left', width: 220, sortable: false }),
      renderColumn<Asin360CompareRow>('本期', 'value', row => cell(row, row.value, currency, STATE_TEXT[row.state] || '尚无记录'), { group: '取值', width: 160, sortable: false, ...RIGHT_ALIGNED }),
      renderColumn<Asin360CompareRow>('对比期', 'prevValue', row => cell(row, row.prevValue, currency, comparing ? '尚无记录' : '未选对比期'), {
        group: '取值',
        width: 160,
        sortable: false,
        ...RIGHT_ALIGNED,
      }),
      renderColumn<Asin360CompareRow>('变化率', 'changeRate', row => <DeltaText ratio={row.changeRate} goodWhen={row.metric === 'adsSpend' ? 'down' : undefined} />, {
        group: '变化',
        width: 120,
        sortable: false,
        ...RIGHT_ALIGNED,
      }),
      renderColumn<Asin360CompareRow>('变化量', 'changeValue', row => changeValueText(row, currency), { group: '变化', width: 160, sortable: false, ...RIGHT_ALIGNED }),
    ],
    [currency, comparing],
  )
  const fetchPage = useCallback<PageFetcher<Asin360CompareRow>>(
    async ({ page, pageSize }) => ({ items: data.rows.slice((page - 1) * pageSize, page * pageSize), total: data.rows.length }),
    [data.rows],
  )
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }} data-testid="asin360-compare">
      <Muted>
        {comparing
          ? `本期 ${data.period.from} 至 ${data.period.to}；对比期 ${data.compare?.from} 至 ${data.compare?.to}`
          : `本期 ${data.period.from} 至 ${data.period.to}；没有选对比方式，对比列为空（在上方日期旁选择环比、同比或自定义）`}
      </Muted>
      {data.note ? <Muted>{data.note}</Muted> : null}
      <PagedGrid<Asin360CompareRow>
        gridId="asin360.compare"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.metric}
        resetKey={`${data.period.from}:${data.period.to}:${data.compare?.from ?? ''}:${data.compare?.to ?? ''}`}
        emptyState={{ kind: 'empty', domain: '同环比明细', prerequisite: '需要这个商品有订单记录' }}
        height={380}
      />
    </Space>
  )
}

export function CompareSection({ id }: { id: string }) {
  const query = useProductQuery<Asin360CompareResponse>(id, 'compare', { scoped: true })
  return <QueryBody query={query}>{data => <CompareGrid data={data} />}</QueryBody>
}
