import type { ReactNode } from 'react'
import { Space, Tag, Tooltip } from 'antd'
import { AD_TERM_ANOMALY_LABEL, ADS_TERM_STATUS_LABEL, type AdsTermStatus, type AdTermAnomaly, type AdTermCampaigns } from '@nova/api-contracts'
import { AppLink } from '../../nav/AppLink'

// 词级中心的小件（P3-10）：状态标签、异常分组标签、到词级分析页的链接。公共小件放在页面自己的目录里。

export const STATUS_COLOR: Record<AdsTermStatus, string> = { TARGETED: 'success', NEGATED: 'default', UNTARGETED: 'warning' }
export const ANOMALY_COLOR: Record<AdTermAnomaly, string> = { HIGH_SPEND_NO_ORDER: 'error', SCALE_UP: 'success', ADD_KEYWORD: 'processing', NEGATIVE_CANDIDATE: 'warning' }

/** 状态标签；悬停说明在几个活动里出现、其中几个已投放、几个已否定。 */
export function StatusTag({ status, campaigns }: { status: AdsTermStatus; campaigns: AdTermCampaigns }) {
  const tag = (
    <Tag color={STATUS_COLOR[status]} bordered={false}>
      {ADS_TERM_STATUS_LABEL[status]}
    </Tag>
  )
  return (
    <Tooltip title={`在 ${campaigns.total} 个活动里出现，其中 ${campaigns.targeted} 个已投放、${campaigns.negated} 个已否定`}>
      <span>{tag}</span>
    </Tooltip>
  )
}

export function AnomalyTags({ anomalies }: { anomalies: readonly AdTermAnomaly[] }): ReactNode {
  if (anomalies.length === 0) return null
  return (
    <Space size={[4, 4]} wrap>
      {anomalies.map(anomaly => (
        <Tag key={anomaly} color={ANOMALY_COLOR[anomaly]} bordered={false}>
          {AD_TERM_ANOMALY_LABEL[anomaly]}
        </Tag>
      ))}
    </Space>
  )
}

/** 到词级分析页的链接：词放在地址栏参数里，范围参数沿用。 */
export function TermLink({ term, children }: { term: string; children?: ReactNode }) {
  return (
    <AppLink to="/app/ad-terms/detail" search={{ term }}>
      {children ?? term}
    </AppLink>
  )
}
