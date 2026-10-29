import { Tabs } from 'antd'
import { PageHeader } from '../../components'
import { TemplateLibrary } from './ads-reports-library'
import { useReportTemplates } from './ads-reports-data'
import { ParityTab } from './ads-reports-parity'
import { ReportTasks } from './ads-reports-tasks'

// 广告报表（P3-15，08 章 8.12）：报告任务（创建、历史回补、重试、历史可用起点）、模板库、新旧接口迁移期核对。
// 取数走亚马逊广告新报告接口：后台创建、轮询、下载并按模板写入指标表；失败原因如实写出，没有数据写“尚无记录”，不写 0。

export default function AdsReportsPage() {
  const templates = useReportTemplates()
  return (
    <div data-testid="ads-reports-page">
      <PageHeader title="广告报表" description="向亚马逊广告创建报告任务并导入指标：按模板选择维度与指标，可一次补取历史数据；迁移期可对照新旧接口的数据差异。" />
      <Tabs
        defaultActiveKey="tasks"
        items={[
          { key: 'tasks', label: '报告任务', children: <ReportTasks templates={templates.data} /> },
          { key: 'library', label: '模板库', children: <TemplateLibrary data={templates.data} loading={templates.isFetching} error={templates.error} onRetry={() => void templates.refetch()} /> },
          { key: 'parity', label: '迁移核对', children: <ParityTab /> },
        ]}
      />
    </div>
  )
}
