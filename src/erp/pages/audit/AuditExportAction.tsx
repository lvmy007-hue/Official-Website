import { AUDIT_EXPORT_KIND } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 审计日志导出（09 章 9.11）：走导出任务，条件与页面完全一致（时间用页面选定的起止时刻），文件生成后在导出中心下载；发起导出会写一条审计。
// 文件里是列表上的列加来源地址与请求编号，不含修改前后的内容。

export type AuditExportFilters = Record<string, string>

export function AuditExportAction({ filters, summary, canExport, blockedReason }: { filters: AuditExportFilters; summary: string; canExport: boolean; blockedReason: string | null }) {
  const create = useApiMutation<Record<string, unknown>>({ method: 'POST', path: '/exports', invalidate: ['realtime'], silent: true })
  return (
    <FormAction
      label="发起导出"
      guard={{ permission: 'export.create', condition: { ok: canExport, reason: blockedReason ?? '当前不能发起导出' } }}
      title="导出审计日志"
      description="导出当前筛选条件下的全部审计记录（不只是当前一页），按发生时间从新到旧；不含修改前后的内容。没有选时间范围时导出全部历史记录。生成后在“导出中心”下载，发起导出本身也会记入审计。"
      okText="发起导出"
      successText="导出已提交，生成后可在导出中心下载"
      onSubmit={() => create.mutateAsync({ kind: AUDIT_EXPORT_KIND, format: 'CSV', filters, filterSummary: summary.slice(0, 300) })}
    />
  )
}
