import { Button } from 'antd'
import { LazyResult as Result } from '../components/data-state/LazyResult'
import { DataState } from '../components/data-state/DataState'
import { AppLink } from '../nav/AppLink'

// 路由层的正式状态页：页面不存在、无权限、地址参数不正确。任何地方都不出现“规划中”字样。

export function NotFoundPage() {
  return (
    <Result
      status="404"
      title="页面不存在"
      subTitle="该地址没有对应的页面，可能已被移除，或尚未开放。"
      extra={
        <AppLink to="/app/overview" keepScope={false}>
          <Button type="primary">回到经营控制台</Button>
        </AppLink>
      }
    />
  )
}

export function ForbiddenPage({ permission }: { permission: string }) {
  return <DataState kind="forbidden" permission={permission} />
}

export function SearchParamErrorPage({ message, resetTo }: { message: string; resetTo: string }) {
  return (
    <Result
      status="warning"
      title="地址里的筛选参数不正确"
      subTitle={message}
      extra={
        <AppLink to={resetTo} keepScope={false}>
          <Button type="primary">清除筛选条件</Button>
        </AppLink>
      }
    />
  )
}
