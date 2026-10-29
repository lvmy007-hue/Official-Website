import { Alert, Card, Space, Statistic, Tag, Typography } from 'antd'
import {
  DIFF_CLASSES,
  DIFF_CLASS_LABEL,
  DIFF_CLASS_NOTE,
  type Asin360CostsResponse,
  type Asin360OfficialResponse,
  type Asin360PreviewResponse,
  type EconomicsCompareRow,
  type EconomicsPreviewFeeGroup,
  type EconomicsPreviewRow,
} from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { useSession } from '../../session/session'
import { VersionTimeline } from '../costs/costs-versions'
import { compareColumns } from '../economics/CompareTab'
import { previewColumns, previewGroupColumns } from '../economics/PreviewTab'
import { signedMoney } from '../economics/economics-ui'
import { Muted, StateBlock } from '../inventory/inventory-ui'
import { QueryBody, useProductQuery } from './asin360-hooks'

// “利润与成本”页签的三个官方与成本区块（P2b-17）：官方对照（逐日）、费用预览、成本版本时间线。
// 各自有自己的准入，没有权限只是这一块写明需要什么权限，不影响页签的其他部分；列与口径复用官方核对页（P2b-11）与商品成本页（P2b-14）。

const LACK = (what: string) => <Alert type="warning" showIcon message="无权查看" description={`需要${what}`} />

function OfficialBody({ data }: { data: Asin360OfficialResponse }) {
  const { summary } = data
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {data.officialCoverage ? (
        <Muted>
          官方数据覆盖 {data.officialCoverage.from} 至 {data.officialCoverage.to}；我方口径：{data.basisLabel}；金额单位 {data.currency}。
        </Muted>
      ) : null}
      <Space size={32} wrap data-testid="asin360-official-summary">
        <Statistic title="可核对天数" value={summary.comparable} suffix={`/ ${summary.rows}`} />
        <Statistic title="一致" value={summary.matched} />
        <Statistic title="无法核对" value={summary.notComparable} />
        <Statistic title="净差异合计（官方−我方）" formatter={() => (summary.netDiff === null ? <Muted>尚无记录</Muted> : signedMoney(summary.netDiff))} />
      </Space>
      <Space wrap>
        {DIFF_CLASSES.map(name => (
          <Tag key={name} bordered={false} title={DIFF_CLASS_NOTE[name]}>
            {DIFF_CLASS_LABEL[name]}：{signedMoney(summary.byClass[name].amount)}（{summary.byClass[name].rows} 天）
          </Tag>
        ))}
      </Space>
      {data.truncated ? <Alert type="warning" showIcon message="数据行数超过读取上限，核对不完整，请缩小日期范围" /> : null}
      <SimpleGrid<EconomicsCompareRow>
        gridId="products.economics-sections"
        columns={compareColumns}
        rows={data.items}
        rowKey={row => row.key}
        emptyState={{ kind: 'empty', domain: '官方经济数据核对', prerequisite: data.note ?? '所选范围内没有这个商品的官方记录。' }}
      />
      {data.notes.map(note => (
        <div key={note}>
          <Muted>{note}</Muted>
        </div>
      ))}
    </Space>
  )
}

export function OfficialSection({ id }: { id: string }) {
  const { canPermission } = useSession()
  const allowed = canPermission('finance.read') && canPermission('field.profit') && canPermission('field.cost')
  const query = useProductQuery<Asin360OfficialResponse>(id, 'economics/official', { scoped: true, enabled: allowed })
  return (
    <Card size="small" title="官方对照（亚马逊数据中心）" data-testid="asin360-official">
      {allowed ? <QueryBody query={query}>{data => <OfficialBody data={data} />}</QueryBody> : LACK('财务读取权限（finance.read）、利润字段权限（field.profit）和成本字段权限（field.cost）')}
    </Card>
  )
}

function PreviewBody({ data }: { data: Asin360PreviewResponse }) {
  return (
    <StateBlock state={data.state === 'OK' ? 'OK' : 'NO_DATA'} note={data.note}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {data.horizon ? (
          <Muted>
            官方预览覆盖 {data.horizon.from} 至 {data.horizon.to}
            {data.queriedAt ? `，最近查询于 ${data.queriedAt.slice(0, 16).replace('T', ' ')}（UTC）` : ''}；金额单位 {data.currency}。
          </Muted>
        ) : null}
        <Space size={32} wrap>
          <Statistic title="有费用调整的行" value={data.summary.changedRows} suffix={`/ ${data.summary.rows}`} />
          <Statistic title="算不出影响的行" value={data.summary.unknownRows} />
          <Statistic title="合计对利润的影响" formatter={() => (data.summary.totalImpact === null ? <Muted>尚无记录</Muted> : signedMoney(data.summary.totalImpact))} />
        </Space>
        <SimpleGrid<EconomicsPreviewFeeGroup>
          gridId="products.economics-sections-2"
          columns={previewGroupColumns}
          rows={data.summary.byFeeType}
          rowKey={row => row.feeType}
          emptyState={{ kind: 'empty', domain: '费用类型汇总', prerequisite: '官方预览尚无记录。' }}
        />
        <SimpleGrid<EconomicsPreviewRow>
          gridId="products.economics-sections-3"
          columns={previewColumns}
          rows={data.items}
          rowKey={row => row.key}
          emptyState={{ kind: 'empty', domain: '官方费用预览', prerequisite: data.note ?? '没有行。' }}
        />
        {data.notes.map(note => (
          <div key={note}>
            <Muted>{note}</Muted>
          </div>
        ))}
      </Space>
    </StateBlock>
  )
}

export function PreviewSection({ id }: { id: string }) {
  const { canPermission } = useSession()
  const allowed = canPermission('finance.read')
  const query = useProductQuery<Asin360PreviewResponse>(id, 'economics/preview', { enabled: allowed })
  return (
    <Card size="small" title="费用预览（未来 120 天内官方给出的费用调整）" data-testid="asin360-preview">
      {allowed ? <QueryBody query={query}>{data => <PreviewBody data={data} />}</QueryBody> : LACK('财务读取权限（finance.read）')}
    </Card>
  )
}

function CostsBody({ data }: { data: Asin360CostsResponse }) {
  return (
    <StateBlock state={data.state === 'OK' ? 'OK' : 'NO_DATA'} note={data.note}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <VersionTimeline sku={data.sku} versions={data.versions} canWrite={false} truncated={data.versionsTruncated} />
        <Typography.Text type="secondary">这里只读；新增、修改与确认生效到“商品成本”页操作。</Typography.Text>
      </Space>
    </StateBlock>
  )
}

export function CostsSection({ id }: { id: string }) {
  const { canPermission } = useSession()
  const allowed = canPermission('costs.read') && canPermission('field.cost')
  const query = useProductQuery<Asin360CostsResponse>(id, 'economics/costs', { enabled: allowed })
  return (
    <Card size="small" title="成本版本时间线" data-testid="asin360-costs">
      {allowed ? <QueryBody query={query}>{data => <CostsBody data={data} />}</QueryBody> : LACK('成本读取权限（costs.read）和成本字段权限（field.cost）')}
    </Card>
  )
}
