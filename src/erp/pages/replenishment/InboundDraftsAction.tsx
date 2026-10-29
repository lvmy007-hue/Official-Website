import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App, Button, Modal, Space, Tooltip, Typography } from 'antd'
import { BATCH_INBOUND_PERMISSION, INBOUND_WRITE, permissionDeniedMessage, type ToInboundDraftsPreview, type ToInboundDraftsResult } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { AppLink } from '../../nav/AppLink'
import { describeError } from '../../query/errors'
import { useOptionalSession } from '../../session/session'
import { InboundDraftGroups, InboundDraftResult, type Edit, type Edits } from './inbound-drafts-view'

// 补货批次一键转入仓计划草稿（P6-08，16 章第 5.2 节）：勾选建议 → 先预览 → 确认后才创建。
// - 预览：按“店铺 + 发货地址”分组，每组一份草稿；数量取按箱规取整后的建议量，可以手改；每组可以改用该店铺的别的地址；
//   数字与能不能确认都以服务端预览为准（改数量、改地址后重新取预览），界面不自己判断；
// - 不能确认的原因逐条列出：店铺没有发货地址（给“去设置”入口）、建议已转过草稿（指出在哪份草稿里）、数量为 0、SKU 不在商品目录；
// - 确认后创建本地草稿（不调用亚马逊），来源记为补货批次；成功后列出新草稿的链接，草稿之后照常走入仓计划的资格预检、写入开关、提交。

export type InboundTarget = { recommendationId: string; /** 预先填好的数量（例如以前登记意向时决定的数量）；不传就取建议量。 */ qty?: number | null }

const DEBOUNCE_MS = 300

const initialEdits = (targets: readonly InboundTarget[]): Edits => Object.fromEntries(targets.flatMap(target => (target.qty ? [[target.recommendationId, { qty: target.qty }]] : [])))

export function InboundDraftsAction({
  batchId,
  targets,
  onDone,
  label = '生成入仓计划草稿',
  size,
}: {
  batchId: string
  targets: readonly InboundTarget[]
  onDone: () => void
  label?: string
  size?: 'small' | 'middle'
}) {
  const session = useOptionalSession()
  const { message } = App.useApp()
  const [open, setOpen] = useState(false)
  const [edits, setEdits] = useState<Edits>({})
  const [preview, setPreview] = useState<ToInboundDraftsPreview | null>(null)
  const [result, setResult] = useState<ToInboundDraftsResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const sequence = useRef(0)
  const path = `/replenishment/batches/${encodeURIComponent(batchId)}/to-inbound-drafts`

  // 用序列化后的字符串当依赖：父组件重新渲染时 targets 数组是新对象，但内容没变就不该重新取预览
  const itemsJson = useMemo(
    () =>
      JSON.stringify(
        targets.map(target => {
          const edit = edits[target.recommendationId]
          return { recommendationId: target.recommendationId, ...(edit?.qty ? { qty: edit.qty } : {}), ...(edit?.shipFromAddressId ? { shipFromAddressId: edit.shipFromAddressId } : {}) }
        }),
      ),
    [targets, edits],
  )

  // 打开后、以及每次改数量或地址后（稍等一下合并连续输入）重新取预览；只认最后一次请求的返回
  useEffect(() => {
    if (!open || result) return
    const mine = ++sequence.current
    setLoading(true)
    const timer = setTimeout(() => {
      apiFetch<ToInboundDraftsPreview>(path, { method: 'POST', body: `{"dryRun":true,"items":${itemsJson}}` })
        .then(data => {
          if (sequence.current !== mine) return
          setPreview(data)
          setFailure(null)
        })
        .catch((error: unknown) => {
          if (sequence.current !== mine) return
          const info = describeError(error)
          setFailure(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
        })
        .finally(() => {
          if (sequence.current === mine) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, result, path, itemsJson])

  const has = (permission: string) => session?.canPermission(permission) ?? false
  const reason = !has(BATCH_INBOUND_PERMISSION)
    ? permissionDeniedMessage(BATCH_INBOUND_PERMISSION)
    : !has(INBOUND_WRITE)
      ? permissionDeniedMessage(INBOUND_WRITE)
      : targets.length === 0
        ? '请先勾选要转入仓计划的建议'
        : null

  const openIt = () => {
    setEdits(initialEdits(targets))
    setPreview(null)
    setResult(null)
    setFailure(null)
    setOpen(true)
  }
  const close = () => {
    if (saving) return
    const wasDone = result !== null
    setOpen(false)
    if (wasDone) onDone()
  }
  const change = (recommendationIds: readonly string[], patch: Edit) => setEdits(current => ({ ...current, ...Object.fromEntries(recommendationIds.map(id => [id, { ...current[id], ...patch }])) }))

  const confirm = async () => {
    setSaving(true)
    setFailure(null)
    try {
      const data = await apiFetch<ToInboundDraftsResult>(path, { method: 'POST', body: `{"dryRun":false,"items":${itemsJson}}` })
      setResult(data)
      void message.success(`已生成 ${data.plans.length} 份入仓计划草稿`)
    } catch (error) {
      const info = describeError(error)
      setFailure(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    } finally {
      setSaving(false)
    }
  }

  if (reason) {
    return (
      <Tooltip title={reason}>
        <span>
          <Button disabled size={size}>
            {label}
          </Button>
        </span>
      </Tooltip>
    )
  }

  const draftCount = preview?.groups.length ?? 0
  return (
    <>
      <Button size={size} onClick={openIt}>
        {label}
      </Button>
      <Modal
        open={open}
        title={result ? '已生成入仓计划草稿' : `生成入仓计划草稿（已选 ${targets.length} 条建议）`}
        width={760}
        destroyOnClose
        maskClosable={false}
        onCancel={close}
        cancelText={result ? '关闭' : '取消'}
        okText={result ? '完成' : draftCount > 0 ? `确认生成 ${draftCount} 份草稿` : '确认生成'}
        okButtonProps={{ disabled: result ? false : !preview?.canConfirm || loading, loading: saving }}
        onOk={result ? close : () => void confirm()}
      >
        {result ? (
          <InboundDraftResult result={result} />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert type="info" showIcon message="只生成本地草稿，不会调用亚马逊" description="一个店铺加一个发货地址生成一份草稿；草稿之后照常做资格预检，全部通过再提交创建（提交受写入开关控制）。" />
            {failure ? <Alert type="error" showIcon message={failure} /> : null}
            {preview && preview.blockers.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message="现在还不能生成"
                description={
                  <Space direction="vertical" size={2}>
                    {preview.blockers.map(item => (
                      <span key={item}>{item}</span>
                    ))}
                    {preview.remedy ? (
                      <AppLink to={preview.remedy.path}>
                        <Typography.Link>{preview.remedy.label}</Typography.Link>
                      </AppLink>
                    ) : null}
                  </Space>
                }
              />
            ) : null}
            {preview && preview.converted.length > 0 ? (
              <Alert
                type="info"
                showIcon
                message="这些建议已经转过草稿，默认不重复生成"
                description={
                  <Space direction="vertical" size={2}>
                    {preview.converted.map(item => (
                      <span key={item.recommendationId}>
                        {item.sku} 已在草稿
                        <AppLink to={`/app/supply-chain/${encodeURIComponent(item.planId)}`}>
                          <Typography.Link>「{item.planName}」</Typography.Link>
                        </AppLink>
                        中
                      </span>
                    ))}
                  </Space>
                }
              />
            ) : null}
            {preview ? (
              <InboundDraftGroups groups={preview.groups} edits={edits} onChange={change} disabled={saving} />
            ) : loading ? (
              <Typography.Text type="secondary">正在生成预览…</Typography.Text>
            ) : null}
          </Space>
        )}
      </Modal>
    </>
  )
}
