import { useCallback, useMemo, useState } from 'react'
import { Alert, Form, Input, Space } from 'antd'
import { HIJACK_LIMITS, HIJACK_MANAGE, HIJACK_SELLER_ID_PATTERN, type HijackWhitelistResponse, type HijackWhitelistRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PagedGrid, renderColumn, RIGHT_ALIGNED, type ErpColDef, type PageFetcher } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'

// 跟卖白名单（P6-17）：自己的其他店铺、授权分销商这类卖家出现在我方 Listing 上不算跟卖；白名单按企业生效，列表默认不显示、预警不计入。
// 只存卖家编号的哈希与前后各两位的提示，不存编号原文；新增与删除只改本系统，不调用亚马逊。删除后该卖家若仍在报价，会重新进入跟卖列表与预警。

const GUARD = { permission: HIJACK_MANAGE } as const

function RemoveAction({ row, onDone }: { row: HijackWhitelistRow; onDone: () => void }) {
  return (
    <FormAction
      label="移出白名单"
      title={`把 ${row.sellerHint} 移出白名单`}
      okText="移出"
      danger
      guard={GUARD}
      buttonProps={{ size: 'small' }}
      description="移出后，如果这个卖家仍在我方商品上报价，会重新出现在跟卖列表，并参与跟卖预警。"
      successText="已移出白名单"
      onSubmit={async () => {
        await apiFetch(`/tools/hijack/whitelist/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      }}
      onDone={onDone}
    />
  )
}

function AddAction({ onDone, disabledReason }: { onDone: () => void; disabledReason: string | null }) {
  return (
    <FormAction
      label="添加卖家"
      title="添加到跟卖白名单"
      okText="添加"
      guard={GUARD}
      description={`填写亚马逊卖家编号（${HIJACK_LIMITS.sellerIdMin} 到 ${HIJACK_LIMITS.sellerIdMax} 位大写字母或数字）。系统只保存它的哈希与前后各两位的提示，不保存编号原文。`}
      successText="已加入白名单"
      buttonProps={{ type: 'primary', title: disabledReason ?? undefined }}
      onSubmit={async values => {
        const body = { sellerId: String(values.sellerId ?? ''), note: values.note ? String(values.note) : undefined }
        await apiFetch('/tools/hijack/whitelist', { method: 'POST', body: JSON.stringify(body) })
      }}
      onDone={onDone}
    >
      <Form.Item
        name="sellerId"
        label="卖家编号"
        normalize={(value: string) => (value ?? '').toUpperCase().replace(/\s/g, '')}
        rules={[
          { required: true, message: '请填写卖家编号' },
          { pattern: HIJACK_SELLER_ID_PATTERN, message: `卖家编号是 ${HIJACK_LIMITS.sellerIdMin} 到 ${HIJACK_LIMITS.sellerIdMax} 位的大写字母或数字` },
        ]}
      >
        <Input autoComplete="off" placeholder="例如 A1B2C3D4E5F6G7" />
      </Form.Item>
      <Form.Item name="note" label="备注（可选）" rules={[{ max: HIJACK_LIMITS.noteMax, message: `最多 ${HIJACK_LIMITS.noteMax} 个字符` }]}>
        <Input autoComplete="off" placeholder="例如：自己的欧洲店" />
      </Form.Item>
    </FormAction>
  )
}

export function HijackWhitelistPanel() {
  const [version, setVersion] = useState(0)
  const [meta, setMeta] = useState<Pick<HijackWhitelistResponse, 'limit' | 'total' | 'manageBlockedReason'> | null>(null)
  const refresh = useCallback(() => setVersion(current => current + 1), [])

  const fetchPage = useCallback<PageFetcher<HijackWhitelistRow>>(async ({ page, pageSize, signal }) => {
    const response = await apiFetch<HijackWhitelistResponse>(`/tools/hijack/whitelist?page=${page}&pageSize=${pageSize}`, { signal })
    setMeta({ limit: response.limit, total: response.total, manageBlockedReason: response.manageBlockedReason })
    return { items: response.items, total: response.total }
  }, [])

  const columns = useMemo<ErpColDef<HijackWhitelistRow>[]>(
    () => [
      renderColumn<HijackWhitelistRow>('卖家', 'sellerRef', row => <span className="erp-num">{`${row.sellerRef}（${row.sellerHint}）`}</span>, { group: '卖家', pin: 'left', width: 220 }),
      renderColumn<HijackWhitelistRow>('备注', 'note', row => row.note ?? <Muted>无</Muted>, { group: '卖家', width: 260 }),
      renderColumn<HijackWhitelistRow>('现在仍在报价的商品数', 'activeSkus', row => <span className="erp-num">{row.activeSkus}</span>, { group: '现状', width: 170, ...RIGHT_ALIGNED }),
      renderColumn<HijackWhitelistRow>('添加时间', 'createdAt', row => timeText(row.createdAt), { group: '现状', width: 170 }),
      renderColumn<HijackWhitelistRow>('操作', 'actions', row => <RemoveAction row={row} onDone={refresh} />, { group: '操作', pin: 'right', width: 130, sortable: false }),
    ],
    [refresh],
  )

  return (
    <div data-testid="hijack-whitelist">
      <Space style={{ marginBottom: 8 }} wrap>
        <AddAction onDone={refresh} disabledReason={meta?.manageBlockedReason ?? null} />
        {meta ? <Muted>{`白名单 ${meta.total} / ${meta.limit} 个卖家，按企业生效`}</Muted> : null}
      </Space>
      {meta?.manageBlockedReason ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={meta.manageBlockedReason} /> : null}
      <PagedGrid<HijackWhitelistRow>
        gridId="tools.hijack.whitelist"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        resetKey={String(version)}
        emptyState={{ kind: 'empty', domain: '跟卖白名单', prerequisite: '白名单为空：自己的其他店铺或授权分销商出现在商品上时，会被当作跟卖提醒；把它们加进来就不再提醒。' }}
        height={420}
      />
    </div>
  )
}
