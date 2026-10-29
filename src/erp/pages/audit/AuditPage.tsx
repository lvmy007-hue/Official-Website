import { useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { Card, Tabs } from 'antd'
import { PageHeader } from '../../components'
import { AuditLogTab } from './AuditLogTab'
import { PiiViewsTab } from './PiiViewsTab'

// 审计中心（P5-09，09 章 9.11）：审计日志（服务端筛选、导出）与“个人信息明文查看”专门视图。
// 预警跳转会带 view=pii&actorId=…，直接打开明文查看视图并筛到那个人。
// 审计日志不分店铺，页面不受全局范围栏影响。

export default function AuditPage() {
  const search = useSearch({ strict: false }) as { view?: string; actorId?: string }
  const [tab, setTab] = useState(search.view === 'pii' ? 'pii' : 'log')
  return (
    <div>
      <PageHeader title="审计中心" description="企业内每一次修改、授权、导出与查看买家信息明文的记录：谁、什么时候、从哪个页面或接口、对什么对象做了什么、结果如何。记录只能新增，不能修改或删除。" />
      <Card size="small">
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'log', label: '审计日志', children: <AuditLogTab /> },
            { key: 'pii', label: '个人信息明文查看', children: <PiiViewsTab initialActorId={search.view === 'pii' ? search.actorId : undefined} /> },
          ]}
        />
      </Card>
    </div>
  )
}
