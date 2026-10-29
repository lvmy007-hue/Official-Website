import { Alert, Card, Typography } from 'antd'
import { AppLink } from '../../nav/AppLink'
import { formatNumber, formatPercent, toneClassName, toneOf } from '../../format'
import { decomposeBridge, decomposeProduct, type BridgeItem, type Contribution, type Factor } from './analysis'

// 指标树归因（03 章 3.4 第 5 项）：核心指标变化自动分解，按贡献排序给出主因。
// 乘积型（销售额 = 会话 × 转化率 × 件单价）用对数平均分解；加法型（利润桥）逐项分解。

export type AttributionProps =
  | { title: string; kind: 'product'; factors: Factor[]; formatTotal: (n: number) => string; evidenceHref?: (key: string) => string | undefined }
  | { title: string; kind: 'bridge'; items: BridgeItem[]; formatTotal: (n: number) => string; evidenceHref?: (key: string) => string | undefined }

function Bars({ contributions, format, evidence }: { contributions: Contribution[]; format: (n: number) => string; evidence?: (key: string) => string | undefined }) {
  const max = Math.max(...contributions.map(item => Math.abs(item.contribution)), 1e-9)
  return (
    <div role="list">
      {contributions.map((item, index) => (
        <div key={item.key} role="listitem" style={{ display: 'grid', gridTemplateColumns: '140px 1fr 120px 70px', alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <span>
            {index === 0 ? <strong>主因 · </strong> : null}
            {evidence?.(item.key) ? <AppLink to={evidence(item.key)!}>{item.label}</AppLink> : item.label}
          </span>
          <div style={{ position: 'relative', height: 8, background: 'var(--ant-color-fill-quaternary)', borderRadius: 4 }}>
            <div
              style={{
                width: `${(Math.abs(item.contribution) / max) * 100}%`,
                height: '100%',
                borderRadius: 4,
                background: item.contribution >= 0 ? 'var(--ant-color-success)' : 'var(--ant-color-error)',
              }}
            />
          </div>
          <span className={`erp-num ${toneClassName(toneOf(item.contribution))}`} style={{ textAlign: 'right' }}>
            {item.contribution > 0 ? '+' : ''}
            {format(item.contribution)}
          </span>
          <span className="erp-num" style={{ textAlign: 'right', color: 'var(--ant-color-text-secondary)' }}>
            {formatPercent(item.share, { digits: 0 })}
          </span>
        </div>
      ))}
    </div>
  )
}

export function MetricTreeAttribution(props: AttributionProps) {
  const result = props.kind === 'product' ? decomposeProduct(props.factors) : decomposeBridge(props.items)
  return (
    <Card size="small" title={`${props.title}：变化归因`} data-testid="metric-tree">
      {result === null ? (
        <Alert type="info" showIcon message="无法归因：某个因子在对比期内为 0 或缺失，乘积型指标需要所有因子都有数据。" />
      ) : (
        <>
          <Typography.Paragraph style={{ marginBottom: 8 }}>
            总变化 <strong className={`erp-num ${toneClassName(toneOf(result.total))}`}>{`${result.total > 0 ? '+' : ''}${props.formatTotal(result.total)}`}</strong>
            ，各因子贡献之和等于总变化。
          </Typography.Paragraph>
          <Bars contributions={result.contributions} format={props.formatTotal} evidence={props.evidenceHref} />
          {props.kind === 'product' ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              因子前后值：{props.factors.map(f => `${f.label} ${formatNumber(f.before, { digits: 2 })} → ${formatNumber(f.after, { digits: 2 })}`).join('；')}
            </Typography.Text>
          ) : null}
        </>
      )}
    </Card>
  )
}
