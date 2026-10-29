import { Card, Tabs } from 'antd'
import { PageHeader } from '../../components'
import { SyncJobsTab } from './SyncJobsTab'
import { SyncQueuesTab } from './SyncQueuesTab'
import { SyncRateLimitsTab } from './SyncRateLimitsTab'

// 同步中心（P5-06，09 章 9.8）：三个页签——任务（真实的后台任务）、队列监控（积压与吞吐）、限速状态（按店铺与接口的令牌桶）。
// 任务页签顶部是各数据域近 24 小时的概况；同步器还没有交付的数据域写“尚未接入”。重试只对失败的任务开放。

export default function SyncCenterPage() {
  return (
    <div>
      <PageHeader title="同步中心" description="各数据域的后台同步任务：看进度、失败原因和过程记录，失败的任务可以重试；也能看队列积压和各店铺的亚马逊限速状态。" />
      <Card size="small">
        <Tabs
          destroyOnHidden
          items={[
            { key: 'jobs', label: '任务', children: <SyncJobsTab /> },
            { key: 'queues', label: '队列监控', children: <SyncQueuesTab /> },
            { key: 'rate-limits', label: '限速状态', children: <SyncRateLimitsTab /> },
          ]}
        />
      </Card>
    </div>
  )
}
