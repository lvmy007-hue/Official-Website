import type { ReactNode } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import { erpAntdThemeFor } from './antd-theme'
import { useDensity } from './density'
import './numeric.css'

dayjs.locale('zh-cn')

// ERP 范围内的统一主题与中文语言包入口。官网页面不使用它，因此不会影响官网样式与产物。
// 主题随个人偏好里的界面密度变化（紧凑或标准）。
export function ErpConfigProvider({ children }: { children: ReactNode }) {
  const density = useDensity()
  return (
    <ConfigProvider theme={erpAntdThemeFor(density)} locale={zhCN} componentSize="middle">
      {children}
    </ConfigProvider>
  )
}
