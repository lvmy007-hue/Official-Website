import { Alert, Card, Tag } from 'antd'
import { formatMoney, formatNumber, formatPercent, toneClassName, toneOf } from '../../format'
import { evaluateDualSource } from './analysis'

// 双源核对（03 章 3.4 第 2 项）：关键数字同时显示“我方计算”与“亚马逊官方”，差异超过阈值标注并分解原因。

export type DualSourceProps = {
  title: string
  format: 'money' | 'number'
  currency?: string
  ours: number
  official: number
  /** 差异阈值（比率），超过即标注。 */
  thresholdRatio: number
  /** 差异分解：每项原因的金额或数量，合计应接近总差异。 */
  reasons?: Array<{ label: string; amount: number }>
}

export function DualSourceCheck(props: DualSourceProps) {
  const fmt = (n: number) => (props.format === 'money' ? formatMoney(n, props.currency ?? 'USD') : formatNumber(n))
  const result = evaluateDualSource(props.ours, props.official, props.thresholdRatio)
  const explained = (props.reasons ?? []).reduce((total, reason) => total + reason.amount, 0)
  const unexplained = result.diff - explained
  return (
    <Card
      size="small"
      title={props.title}
      data-testid="dual-source"
      extra={result.flagged ? <Tag color="warning">差异超过 {formatPercent(props.thresholdRatio, { digits: 1 })}</Tag> : <Tag color="success">一致</Tag>}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>我方计算</div>
          <div className="erp-num" style={{ fontSize: 18, fontWeight: 600 }}>
            {fmt(props.ours)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>亚马逊官方</div>
          <div className="erp-num" style={{ fontSize: 18, fontWeight: 600 }}>
            {fmt(props.official)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>差异</div>
          <div className={`erp-num ${toneClassName(toneOf(Math.abs(result.diff) < 1e-9 ? 0 : -1))}`} style={{ fontSize: 18, fontWeight: 600 }}>
            {fmt(result.diff)}（{result.diffRatio === null ? '官方值为 0' : formatPercent(result.diffRatio, { sign: true })}）
          </div>
        </div>
      </div>
      {result.flagged && props.reasons ? (
        <div style={{ marginTop: 8 }}>
          <Alert
            type="warning"
            showIcon
            message="差异原因分解"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {props.reasons.map(reason => (
                  <li key={reason.label}>
                    {reason.label}：{fmt(reason.amount)}
                  </li>
                ))}
                {Math.abs(unexplained) > 1e-9 ? <li>尚未解释的差异：{fmt(unexplained)}</li> : null}
              </ul>
            }
          />
        </div>
      ) : null}
    </Card>
  )
}
