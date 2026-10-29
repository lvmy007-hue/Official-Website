import { Alert, App } from 'antd'
import {
  PRODUCT_EXPORT_KIND,
  PRODUCT_EXPORT_PERMISSION,
  PRODUCT_SYNC_PERMISSION,
  PRODUCT_WATCH_BATCH_MAX,
  PRODUCT_WATCH_ENTITY,
  PRODUCT_WATCH_PERMISSION,
  describeProductFilters,
  type ProductFilters,
  type ProductListRow,
  type ProductSyncResult,
} from '@nova/api-contracts'
import { ActionGuard, FormAction } from '../../components'
import { apiFetch } from '../../../api'
import { useAppNavigate } from '../../nav/AppLink'
import { useApiMutation } from '../../query/api-query'
import { useScope } from '../../scope/context'

// 商品主数据列表的批量动作（05 章 5.1）：同步商品目录、导出、加入关注、去补货建议。
// 不提供“批量修改刊登”：修改刊登在“刊登质量与合规”里按问题逐条处理（P4-10）。创建补货草稿也不在这里直接创建：补货建议要先看库存与需求，这里只带你过去。

/** 同步商品目录：亚马逊的商品目录同步是店铺级任务，所以按所选商品所在的店铺发起，不是逐个商品。 */
export function SyncAction({ targets }: { targets: readonly ProductListRow[] }) {
  const create = useApiMutation<Record<string, unknown>, ProductSyncResult>({ method: 'POST', path: '/products/sync', invalidate: ['list', 'realtime'], silent: true })
  const { message } = App.useApp()
  const stores = [...new Map(targets.map(row => [row.sellerAccountId, row.storeName])).entries()]
  return (
    <FormAction
      label="同步商品目录"
      title={`同步商品目录（${stores.length} 个店铺）`}
      guard={{ permission: PRODUCT_SYNC_PERMISSION, condition: { ok: stores.length > 0, reason: '请先勾选商品；商品目录按所在店铺整体同步' } }}
      description={
        <>
          <p style={{ margin: '0 0 8px' }}>亚马逊的商品目录同步以店铺为单位：会更新这些店铺的图片、品牌、类目与变体信息，不会逐个商品单独同步。</p>
          <p style={{ margin: 0 }}>店铺：{stores.map(([, name]) => name).join('、')}</p>
        </>
      }
      okText="发起同步"
      onSubmit={async () => {
        const result = await create.mutateAsync({ storeIds: stores.map(([id]) => id) })
        // 部分店铺没有授权连接：已发起的照常生效，没发起的逐个说明原因（不当作整体失败）
        if (result.skipped.length > 0) message.warning(`已发起 ${result.jobs.length} 个店铺的同步；${result.skipped.map(item => `${item.storeName}：${item.reason}`).join('；')}`, 8)
        return result
      }}
      successText="同步任务已提交，完成后数据会更新"
    />
  )
}

export type ExportCondition = ProductFilters & { risk?: string; watched?: boolean }
const EXPORT_KEYS = ['q', 'asin', 'sku', 'parentAsin', 'brand', 'category', 'status', 'fulfillment', 'ownerId', 'tag'] as const satisfies ReadonlyArray<keyof ProductFilters>

/** 发起导出：条件与页面一致（共用同一套筛选），文件生成后在导出中心下载。库存风险与已关注不是商品资料的列，带着它们时不能导出，免得导出的和页面看到的不一样。 */
export function ExportAction({ filters }: { filters: ExportCondition }) {
  const { scope } = useScope()
  const create = useApiMutation<Record<string, unknown>>({ method: 'POST', path: '/exports', invalidate: ['realtime'], silent: true })
  const storeIds = (scope.storeIds as string[] | undefined) ?? []
  const unsupported = Boolean(filters.risk) || filters.watched !== undefined
  const body = Object.fromEntries(EXPORT_KEYS.flatMap(key => (filters[key] ? [[key, filters[key]]] : [])))
  return (
    <FormAction
      label="导出商品资料"
      guard={{ permission: PRODUCT_EXPORT_PERMISSION, condition: { ok: !unsupported, reason: '导出暂不支持“库存风险”与“只看已关注”筛选，请先清除这两项' } }}
      title="导出商品资料"
      description={
        <>
          <p style={{ margin: '0 0 8px' }}>导出当前筛选条件下的全部商品（不只是当前一页）：{describeProductFilters(filters)}。生成后在“导出中心”下载。</p>
          <Alert type="info" showIcon message="只导出商品自身的资料（ASIN、SKU、标题、品牌、类目、价格、负责人、标签等），不含销售、利润、库存数字。" />
        </>
      }
      okText="发起导出"
      successText="导出已提交，生成后可在导出中心下载"
      onSubmit={() =>
        create.mutateAsync({
          kind: PRODUCT_EXPORT_KIND,
          format: 'CSV',
          filters: { ...(storeIds.length ? { storeIds } : {}), ...body },
          filterSummary: `商品主数据：${describeProductFilters(filters)}${storeIds.length ? `，${storeIds.length} 家店铺` : ''}`,
        })
      }
    />
  )
}

/** 加入关注：一次最多 50 个，逐个提交；中途失败会说明已关注了几个。 */
export function WatchAction({ targets, onDone }: { targets: readonly ProductListRow[]; onDone: () => void }) {
  const pending = targets.filter(row => !row.watched)
  const tooMany = pending.length > PRODUCT_WATCH_BATCH_MAX
  return (
    <ActionGuard
      label="加入关注"
      guard={{
        permission: PRODUCT_WATCH_PERMISSION,
        condition: {
          ok: pending.length > 0 && !tooMany,
          reason: targets.length === 0 ? '请先勾选商品' : tooMany ? `一次最多关注 ${PRODUCT_WATCH_BATCH_MAX} 个商品` : '所选商品都已关注',
        },
      }}
      successText="已加入关注"
      onDone={onDone}
      onExecute={async () => {
        let done = 0
        for (const row of pending) {
          const failure = await apiFetch('/watches', { method: 'POST', body: JSON.stringify({ entityType: PRODUCT_WATCH_ENTITY, entityId: row.id }) }).then(
            () => null,
            (error: unknown) => (error instanceof Error ? error.message : '未知错误'),
          )
          if (failure !== null) throw new Error(`已关注 ${done} 个，“${row.sku}”失败：${failure}`)
          done += 1
        }
      }}
    />
  )
}

/** 去补货建议：补货要先看库存与需求，这里不直接创建草稿，只带你过去。 */
export function ReplenishAction() {
  const go = useAppNavigate()
  return <ActionGuard label="去补货建议" guard={{ permission: 'replenishment.read' }} onExecute={async () => go('/app/replenishment')} />
}
