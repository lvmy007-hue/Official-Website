import { Alert, Form, Input } from 'antd'
import { FEE_CATEGORY_LABEL, FEE_EVENTS_RECONCILE, FEE_EXPORT_KIND, FEE_NOTE_MAX, type FeeCategory, type FeeEventRow, type FeeRange } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { useScope } from '../../scope/context'

// 费用事件的动作（07 章 7.5）：标记差异、对账备注、发起导出。
// 对账只改“对账状态与备注”，不改金额与分类；带页面看到的版本号，别人先改了会提示刷新。“已对账”由结算交易的三方核对写入（P2b-07），这里没有手工入口。

export function ReconcileActions({ row, onChanged }: { row: FeeEventRow; onChanged: () => void }) {
  const patch = useApiMutation<Record<string, unknown>>({ method: 'PATCH', path: `/finance/events/${encodeURIComponent(row.id)}/reconciliation`, invalidate: ['list'], silent: true })
  const marked = row.reconciliationStatus === 'DISCREPANCY'
  return (
    <>
      {marked ? (
        <FormAction
          label="取消差异标记"
          buttonProps={{ size: 'small', type: 'link' }}
          guard={{ permission: FEE_EVENTS_RECONCILE }}
          title="取消差异标记"
          description="取消后这条费用回到“未对账”；原来的备注会保留，变更记录里能查到。"
          okText="取消标记"
          successText="已取消差异标记"
          onDone={onChanged}
          onSubmit={() => patch.mutateAsync({ version: row.version, status: 'UNRECONCILED' })}
        />
      ) : (
        <FormAction
          label="标记差异"
          buttonProps={{ size: 'small', type: 'link' }}
          guard={{ permission: FEE_EVENTS_RECONCILE }}
          title="标记差异"
          description="这条费用与结算单、订单或你的预期对不上时标记，方便财务与运营跟进；请写明差在哪里。不会修改金额与分类。"
          initialValues={{ note: row.reconciliationNote ?? '' }}
          okText="标记"
          successText="已标记差异"
          onDone={onChanged}
          onSubmit={values => patch.mutateAsync({ version: row.version, status: 'DISCREPANCY', note: String(values.note ?? '').trim() })}
        >
          <Form.Item label="差异说明" name="note" rules={[{ required: true, whitespace: true, message: '请写明差在哪里' }]}>
            <Input.TextArea aria-label="差异说明" rows={3} maxLength={FEE_NOTE_MAX} showCount />
          </Form.Item>
        </FormAction>
      )}
      <FormAction
        label="对账备注"
        buttonProps={{ size: 'small', type: 'link' }}
        guard={{ permission: FEE_EVENTS_RECONCILE }}
        title="对账备注"
        description="只改备注，不改对账状态；留空表示清除备注。"
        initialValues={{ note: row.reconciliationNote ?? '' }}
        okText="保存"
        successText="备注已保存"
        onDone={onChanged}
        onSubmit={values => patch.mutateAsync({ version: row.version, note: String(values.note ?? '').trim() || null })}
      >
        <Form.Item label="备注" name="note">
          <Input.TextArea aria-label="备注" rows={3} maxLength={FEE_NOTE_MAX} showCount />
        </Form.Item>
      </FormAction>
    </>
  )
}

export type ExportFilters = { category: FeeCategory; status?: string; reconciliation?: string; q?: string }

/** 发起导出：条件与页面完全一致（时间范围用页面返回的起止时刻），文件生成后在导出中心下载。 */
export function ExportAction({ range, filters }: { range: FeeRange | undefined; filters: ExportFilters }) {
  const { scope } = useScope()
  const create = useApiMutation<Record<string, unknown>>({ method: 'POST', path: '/exports', invalidate: ['realtime'], silent: true })
  const storeIds = (scope.storeIds as string[] | undefined) ?? []
  const narrowedByEntity = ((scope.legalEntityIds as string[] | undefined)?.length ?? 0) > 0 && storeIds.length === 0
  return (
    <FormAction
      label="发起导出"
      guard={{ permission: 'export.create', condition: { ok: Boolean(range), reason: '列表还没有加载完成' } }}
      title={`导出费用事件：${FEE_CATEGORY_LABEL[filters.category]}`}
      description={
        <>
          <p style={{ margin: '0 0 8px' }}>
            导出当前页签与筛选条件下的全部费用明细（不只是当前一页），时间范围 {range?.from} 至 {range?.to}。金额带符号，扣费为负；不含销售收入与税。生成后在“导出中心”下载。
          </p>
          {narrowedByEntity ? <Alert type="warning" showIcon message="导出暂不支持按法律主体筛选，会包含你有权限的全部店铺；如需限定，请在范围栏里直接选择店铺。" /> : null}
        </>
      }
      okText="发起导出"
      successText="导出已提交，生成后可在导出中心下载"
      onSubmit={() =>
        create.mutateAsync({
          kind: FEE_EXPORT_KIND,
          format: 'CSV',
          filters: {
            ...(storeIds.length ? { storeIds } : {}),
            category: filters.category,
            ...(filters.status ? { status: filters.status } : {}),
            ...(filters.reconciliation ? { reconciliation: filters.reconciliation } : {}),
            ...(filters.q ? { q: filters.q } : {}),
            fromAt: range?.fromAt ?? '',
            toAt: range?.toAt ?? '',
          },
          filterSummary: `费用事件：${FEE_CATEGORY_LABEL[filters.category]}，${range?.from} 至 ${range?.to}${storeIds.length ? `，${storeIds.length} 家店铺` : ''}`,
        })
      }
    />
  )
}
