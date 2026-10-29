import { useMemo } from 'react'
import { Alert, Card, Col, Row, Statistic, Tag } from 'antd'
import { type SalesTaxAvailability, type SalesTaxReconRow, type SalesTaxResponse, type SalesTaxSourceView, type SalesTaxStoreStatus } from '@nova/api-contracts'
import { LocalGrid, type TreeOptions } from '../../components'
import { formatDateTime, formatNumber } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { sourceColumns, reconColumns, stateColumns, taxGridRows, type TaxGridRow } from './sales-tax-columns'

// 销售税页的各个区块（P2b-12）：报告取得情况、核心数字、数据来源、按州汇总（可展开辖区）、对账。
// 金额没有数据一律显示“尚无记录”，不显示 0；尚未接入的来源写“尚未接入”。

const AVAILABILITY_COLOR: Record<SalesTaxAvailability, string> = { AVAILABLE: 'success', NOT_GENERATED: 'warning', ROLE_PENDING: 'warning', FAILED: 'error', NO_RECORD: 'default' }
const ALERT_TYPE: Record<Exclude<SalesTaxAvailability, 'AVAILABLE'>, 'warning' | 'error' | 'info'> = { NOT_GENERATED: 'warning', ROLE_PENDING: 'warning', FAILED: 'error', NO_RECORD: 'info' }

/** 每家店的税务文档库报告取得情况：不是“已取得”的店铺各一条提示，原因写在提示里。 */
export function StoreStatusSection({ stores }: { stores: readonly SalesTaxStoreStatus[] }) {
  const problems = stores.filter(store => store.state !== 'AVAILABLE')
  if (stores.length === 0) return null
  return (
    <div data-testid="sales-tax-stores" style={{ marginBottom: 8 }}>
      {problems.map(store => (
        <Alert
          key={store.sellerAccountId}
          type={ALERT_TYPE[store.state as Exclude<SalesTaxAvailability, 'AVAILABLE'>]}
          showIcon
          style={{ marginBottom: 6 }}
          message={
            <span>
              {store.storeName}：<Tag color={AVAILABILITY_COLOR[store.state]}>{store.stateLabel}</Tag>
              {store.note}
            </span>
          }
        />
      ))}
      {problems.length < stores.length ? (
        <Muted>
          已取得报告的店铺：
          {stores
            .filter(store => store.state === 'AVAILABLE')
            .map(store => `${store.storeName}${store.lastSuccessAt ? `（${formatDateTime(store.lastSuccessAt)}）` : ''}`)
            .join('、')}
        </Muted>
      ) : null}
    </div>
  )
}

export function TotalsSection({ data }: { data: SalesTaxResponse }) {
  return (
    <Row gutter={[12, 12]} style={{ margin: '8px 0 12px' }} data-testid="sales-tax-totals">
      <Col xs={24} md={8}>
        <Card size="small">
          <Statistic title="平台代收代缴税额（报告）" value={data.totals.taxCollected === null ? '尚无记录' : formatMoneyText(data.totals.taxCollected)} />
        </Card>
      </Col>
      <Col xs={24} md={8}>
        <Card size="small">
          <Statistic title="应税销售额（报告）" value={data.totals.taxableSales === null ? '尚无记录' : formatMoneyText(data.totals.taxableSales)} />
        </Card>
      </Col>
      <Col xs={24} md={8}>
        <Card size="small">
          <Statistic title="订单接口税额" value={data.totals.ordersTax === null ? '尚无记录' : formatMoneyText(data.totals.ordersTax)} />
        </Card>
      </Col>
    </Row>
  )
}

const formatMoneyText = (value: number) => `$${formatNumber(value, { digits: 2 })}`

export function SourcesSection({ sources }: { sources: readonly SalesTaxSourceView[] }) {
  return (
    <div data-testid="sales-tax-sources" style={{ margin: '12px 0' }}>
      <h4 style={{ margin: '0 0 8px' }}>数据来源</h4>
      <LocalGrid<SalesTaxSourceView>
        gridId="finance.sales-tax.sources"
        columns={sourceColumns}
        rows={sources}
        getRowId={row => row.source}
        height={260}
        emptyState={{ kind: 'empty', domain: '数据来源', prerequisite: '暂无来源。' }}
      />
    </div>
  )
}

const TREE: TreeOptions<TaxGridRow> = { hasChildren: row => row.children.length > 0, getChildren: row => row.children }

export function StatesSection({ data }: { data: SalesTaxResponse }) {
  const rows = useMemo(() => taxGridRows(data.states), [data.states])
  return (
    <div data-testid="sales-tax-states" style={{ margin: '12px 0' }}>
      <h4 style={{ margin: '0 0 8px' }}>按州汇总（税务文档库报告）</h4>
      <LocalGrid<TaxGridRow>
        gridId="finance.sales-tax.states"
        columns={stateColumns}
        rows={rows}
        getRowId={row => row.id}
        tree={TREE}
        height={420}
        emptyState={{ kind: 'empty', domain: '按州汇总', prerequisite: '所选范围内没有税务文档库报告数据：需在卖家后台“税务文档库”先生成报告，并获批受限角色“税务汇缴”。' }}
      />
      {data.jurisdictionsTruncated ? (
        <Alert type="warning" showIcon style={{ marginTop: 8 }} message="辖区明细太多，只显示了一部分；各州的合计是完整的，不受影响。" data-testid="sales-tax-truncated" />
      ) : null}
    </div>
  )
}

export function ReconSection({ rows }: { rows: readonly SalesTaxReconRow[] }) {
  return (
    <div data-testid="sales-tax-recon" style={{ margin: '12px 0' }}>
      <h4 style={{ margin: '0 0 8px' }}>与订单对账（按月、按店铺）</h4>
      <LocalGrid<SalesTaxReconRow>
        gridId="finance.sales-tax.recon"
        columns={reconColumns}
        rows={rows}
        getRowId={row => `${row.sellerAccountId}|${row.month}`}
        height={320}
        emptyState={{ kind: 'empty', domain: '对账', prerequisite: '所选范围内报告与订单接口都没有税额记录，无法对账。' }}
      />
    </div>
  )
}
