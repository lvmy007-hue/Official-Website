import { useMemo, type ReactNode } from 'react'
import { Alert } from 'antd'
import type { PeriodPreview, PreviewItem, PreviewItemState } from '@nova/api-contracts'
import { LocalGrid } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { count, money } from '../orders/orders-ui'
import { previewColumns, type PreviewRow } from './periods-columns'

// 关账报表预览（P2b-13）：利润桥逐项，三种收入确认口径并排；未锁定时是实时的利润日表，已关账时是锁定的快照。
// 金额是企业本位币。没数据写“尚无记录”，数据来源没接入写“尚未接入”，没权限写“无权查看”，不用 0 顶替；有商品缺成本时净利润整体不给。

const STATE_TEXT: Record<Exclude<PreviewItemState, 'OK'>, string> = { NO_DATA: '尚无记录', NOT_CONNECTED: '尚未接入', RESTRICTED: '无权查看' }

const cellOf = (item: PreviewItem | undefined): ReactNode => {
  if (!item) return <Muted>尚无记录</Muted>
  if (item.state !== 'OK') return <Muted>{STATE_TEXT[item.state]}</Muted>
  return money(item.value)
}

const rowsOf = (preview: PeriodPreview): PreviewRow[] => {
  const first = preview.bases[0]
  if (!first) return []
  const bridge = first.items.map(item => ({ key: item.key, label: item.label, cells: preview.bases.map(basis => cellOf(basis.items.find(candidate => candidate.key === item.key))) }))
  const net: PreviewRow = {
    key: '__net',
    label: '净利润',
    cells: preview.bases.map(basis => (basis.netProfit === null ? <Muted>{basis.incompleteRows > 0 ? `有 ${basis.incompleteRows} 行缺成本，不给` : '尚无记录'}</Muted> : money(basis.netProfit))),
  }
  const units: PreviewRow = {
    key: '__units',
    label: '销售件数 / 已计成本件数',
    cells: preview.bases.map(basis => (
      <span className="erp-num">
        {count(basis.units)} / {count(basis.costedUnits)}
      </span>
    )),
  }
  return [...bridge, net, units]
}

export function PreviewTab({ preview }: { preview: PeriodPreview }) {
  const columns = useMemo(() => previewColumns(preview.bases), [preview.bases])
  const rows = useMemo(() => rowsOf(preview), [preview])
  if (preview.state === 'RESTRICTED') return <Alert type="warning" showIcon message="无权查看" description={preview.note ?? '关账报表含利润数据，需要利润字段权限。'} />
  if (preview.state === 'NO_DATA' || preview.bases.length === 0) {
    return <Alert type="info" showIcon message="尚无记录" description={preview.note ?? '该店铺这个期间还没有利润日表数据；订单、财务交易同步并计算后显示。'} />
  }
  return (
    <div data-testid="period-preview">
      <Alert
        type={preview.source === 'SNAPSHOT' ? 'success' : 'info'}
        showIcon
        style={{ marginBottom: 8 }}
        message={preview.source === 'SNAPSHOT' ? '已锁定的快照' : '实时数据：未锁定，会随同步更新'}
        description={preview.note ?? undefined}
      />
      <LocalGrid<PreviewRow>
        gridId="finance.periods.preview"
        columns={columns}
        rows={rows}
        getRowId={row => row.key}
        height={480}
        emptyState={{ kind: 'empty', domain: '利润桥', prerequisite: '尚无记录。' }}
      />
      <p style={{ margin: '8px 0 0', color: 'rgba(0,0,0,0.45)', fontSize: 12 }} data-testid="period-preview-note">
        {preview.fx ? `汇率：${preview.fx.currencies.length ? preview.fx.currencies.join('、') : '无外币'}（共 ${preview.fx.rates} 条）。` : ''}
        {preview.costVersions !== null ? `生效中的成本版本 ${preview.costVersions} 条。` : '成本版本需要成本字段权限才显示。'}
      </p>
    </div>
  )
}
