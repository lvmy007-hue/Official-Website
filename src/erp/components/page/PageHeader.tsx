import type { ReactNode } from 'react'
import { Space, Typography } from 'antd'

// 页头（03 章 3.2）：标题、一句话说明、主动作。主动作由页面经动作守卫生成后传入。
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 8 }}>
      <div style={{ minWidth: 0 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {description ? (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {description}
          </Typography.Text>
        ) : null}
      </div>
      {actions ? <Space wrap>{actions}</Space> : null}
    </header>
  )
}
