import { useState, type ReactNode } from 'react'
import { Button } from 'antd'
import { DrillModal, useDrill, type DrillLevel } from '../../components'

// 活动详情里的下钻入口（P6-23，16 章第 8 节）：点广告组、投放、搜索词的名称，不再整页跳转，而是在弹窗里连续下钻（面包屑与后退由 DrillModal 自带）。
// 不在弹窗里时（活动详情页）开一个新的弹窗，根层就是被点的对象；已经在弹窗里时往栈里压一层。每一层的内容由调用方给出（见 ads-drill-levels.tsx）。

/** 活动详情页给各页签的下钻层构造器；没有传时页签退回成整页跳转的链接。 */
export type DrillFactories = {
  adGroup: (row: { id: string; name: string }, currency: string) => DrillLevel
  target: (row: { id: string; expression: string }, currency: string) => DrillLevel
  term: (
    row: { searchTerm: string; status: string; metrics: { impressions: number; clicks: number; spend: number | null; sales: number | null; orders: number } | null },
    currency: string,
  ) => DrillLevel
}

export function DrillLink({ level, heading, children }: { level: DrillLevel; heading?: string; children: ReactNode }) {
  const drill = useDrill()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => (drill ? drill.push(level) : setOpen(true))}>
        {children}
      </Button>
      {drill ? null : <DrillModal open={open} onClose={() => setOpen(false)} root={level} heading={heading} />}
    </>
  )
}
