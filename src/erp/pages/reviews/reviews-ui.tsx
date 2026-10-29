import type { ReactNode } from 'react'
import { Alert, Button, Space, Typography } from 'antd'
import type { ReviewSectionState } from '@nova/api-contracts'
import { formatNumber } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { SECTION_TITLE } from './reviews-state'

// 评价与反馈各页签共用的小件：没有数据写“尚无记录”（不写 0）、区块状态说明、游标翻页、口径文字。

export { Muted }
export const NONE = <Muted>尚无记录</Muted>

/** 数字：没有数据写“尚无记录”。 */
export const numberOrNone = (value: number | null | undefined, digits = 0): ReactNode =>
  value === null || value === undefined ? NONE : <span className="erp-num">{formatNumber(value, { digits })}</span>

/** 个数：没有（0 或没有记录）写“无”，不显示成 0。 */
export const countOrNone = (value: number | null | undefined): ReactNode => (value ? <span className="erp-num">{formatNumber(value, { digits: 0 })}</span> : <Muted>无</Muted>)

/** 区块状态：只有不是 OK 才显示；有原因就写出来。 */
export function SectionNote({ state, note }: { state: ReviewSectionState; note: string | null }) {
  if (state === 'OK') return null
  return <Alert type={state === 'RESTRICTED' ? 'warning' : 'info'} showIcon style={{ margin: '8px 0' }} message={SECTION_TITLE[state]} description={note ?? undefined} />
}

export function ProductCell({ asin, title, storeName }: { asin: string; title: string | null; storeName?: string }) {
  return (
    <div>
      <div>{title ?? 'ASIN 的标题尚无记录'}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {asin}
        {storeName ? ` · ${storeName}` : ''}
      </Typography.Text>
    </div>
  )
}

export const Basis = ({ children }: { children: ReactNode }) => <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{children}</p>

/** 游标翻页：只有上一页与下一页，页码是栈的深度（不显示总页数）。 */
export function Pager({ page, hasNext, busy, onPrev, onNext, note }: { page: number; hasNext: boolean; busy: boolean; onPrev: () => void; onNext: () => void; note?: string }) {
  return (
    <Space style={{ marginTop: 8 }}>
      <Button disabled={page <= 1 || busy} onClick={onPrev}>
        上一页
      </Button>
      <Button disabled={!hasNext || busy} onClick={onNext}>
        下一页
      </Button>
      <span style={{ color: 'rgba(0,0,0,0.45)' }}>
        第 {page} 页{note ? `，${note}` : ''}
      </span>
    </Space>
  )
}
