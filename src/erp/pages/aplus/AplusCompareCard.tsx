import { Alert, Card } from 'antd'
import { APLUS_COMPARE_BASIS, type AplusCompare, type AplusCompareSide, type AplusCompareState } from '@nova/api-contracts'
import { formatDate, formatNumber } from '../../format'
import { conversionText, deltaText, relativeText } from './aplus-format'
import { Basis, NONE } from './aplus-ui'
import { SimpleGrid } from '../../components'

// 发布前后对照（P4-14）：state 为 OK 才显示两侧的会话、订购件数、转化率与差值；其它状态只显示原因，不显示成 0。
// 口径固定显示：只反映时间先后，不代表 A+ 内容带来的因果效果。

const STATE_TITLE: Record<Exclude<AplusCompareState, 'OK'>, string> = {
  NOT_PUBLISHED: '尚无数据',
  NO_PUBLISH_TIME: '尚无数据',
  TOO_RECENT: '尚无数据',
  INSUFFICIENT_DATA: '样本不足',
  NOT_CONNECTED: '尚未接入',
  RESTRICTED: '无权限',
}

interface Line {
  key: string
  label: string
  before: string | null
  after: string | null
}

const sideNumber = (value: number | null) => (value === null ? null : formatNumber(value, { digits: 0 }))
const range = (side: AplusCompareSide) => `${formatDate(side.from)} 至 ${formatDate(side.to)}（${side.daysWithData}/${side.days} 天有数据）`

function lines(before: AplusCompareSide, after: AplusCompareSide): Line[] {
  return [
    { key: 'range', label: '统计区间', before: range(before), after: range(after) },
    { key: 'sessions', label: '会话', before: sideNumber(before.sessions), after: sideNumber(after.sessions) },
    { key: 'units', label: '订购件数', before: sideNumber(before.units), after: sideNumber(after.units) },
    { key: 'conversion', label: '转化率', before: before.conversion === null ? null : conversionText(before.conversion), after: after.conversion === null ? null : conversionText(after.conversion) },
  ]
}

export function AplusCompareCard({ compare }: { compare: AplusCompare }) {
  const ok = compare.state === 'OK' && compare.before && compare.after
  return (
    <Card size="small" title="发布前后对照" style={{ marginTop: 8 }} data-testid="aplus-compare">
      {ok ? (
        <>
          <div style={{ marginBottom: 8 }}>
            上线时间：{compare.publishedAt ? formatDate(compare.publishedAt.slice(0, 10)) : '尚无记录'}；合计 {compare.asinCount} 个关联 ASIN
          </div>
          <SimpleGrid<Line>
            gridId="aplus.aplus-compare-card"
            columns={[
              { title: '项目', dataIndex: 'label', width: 120 },
              { title: '发布前', key: 'before', render: (_v, row) => row.before ?? NONE },
              { title: '发布后', key: 'after', render: (_v, row) => row.after ?? NONE },
            ]}
            rows={lines(compare.before as AplusCompareSide, compare.after as AplusCompareSide)}
            rowKey={row => row.key}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
          />
          <div style={{ marginTop: 8 }} data-testid="aplus-compare-delta">
            转化率差：<strong>{deltaText(compare.delta)}</strong>；相对变化：<strong>{relativeText(compare.relative)}</strong>
          </div>
        </>
      ) : (
        <Alert
          data-testid="aplus-compare-state"
          type={compare.state === 'RESTRICTED' ? 'warning' : 'info'}
          showIcon
          message={STATE_TITLE[compare.state === 'OK' ? 'NOT_PUBLISHED' : compare.state]}
          description={compare.note ?? undefined}
        />
      )}
      <Basis>{APLUS_COMPARE_BASIS}</Basis>
    </Card>
  )
}
