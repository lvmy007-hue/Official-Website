import { useState } from 'react'
import { Alert, Button, Card, Descriptions, Steps, Typography, message } from 'antd'
import { CLOSE_STEPS } from '@nova/api-contracts'
import { formatDateTime, formatNumber } from '../format'
import { describeError } from '../query/errors'
import { platformFetch } from './platform-api'
import type { TenantDetail } from './platform-queries'
import { openSignedUrl } from '../security/safe-url'

// 注销进度（P1-19）：六个步骤的执行情况、导出包下载与删除证明。证明只含各表删除的行数与文件数，不含任何业务内容。

const STEP_STATUS = { PENDING: 'wait', DONE: 'finish', FAILED: 'error' } as const

export function TenantCloseProgress({ tenant, canManage }: { tenant: TenantDetail; canManage: boolean }) {
  const [downloading, setDownloading] = useState(false)
  const state = tenant.closeProgress
  if (!state) return null
  const current = CLOSE_STEPS.findIndex(step => state.steps[step.key]?.state !== 'DONE')
  const failedStep = CLOSE_STEPS.find(step => state.steps[step.key]?.state === 'FAILED')
  const tables = Object.entries(state.proof?.tables ?? {})
  const deletedRows = tables.reduce((sum, [, count]) => sum + count, 0)

  const download = async () => {
    setDownloading(true)
    try {
      const result = await platformFetch<{ url: string }>(`/platform/tenants/${encodeURIComponent(tenant.id)}/close-export`)
      openSignedUrl(result.url)
    } catch (failure) {
      void message.error(describeError(failure).message)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Card
      size="small"
      title={`注销进度（第 ${state.runs} 次执行）`}
      extra={
        state.export && canManage ? (
          <Button size="small" loading={downloading} onClick={() => void download()}>
            下载导出包
          </Button>
        ) : null
      }
    >
      {failedStep ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`“${failedStep.title}”失败：${state.steps[failedStep.key].error ?? '未知原因'}`}
          description="已完成的步骤不会重做。排除原因后，点击页面上方的“继续注销”从失败处续跑。"
        />
      ) : tenant.status === 'CLOSING' ? (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="注销正在后台执行，完成后状态会变为“已注销”。可以稍后刷新页面查看。" />
      ) : null}
      <Steps
        size="small"
        direction="vertical"
        current={current === -1 ? CLOSE_STEPS.length : current}
        items={CLOSE_STEPS.map(step => {
          const record = state.steps[step.key]
          return {
            title: step.title,
            status: STEP_STATUS[record?.state ?? 'PENDING'],
            description: record?.state === 'DONE' && record.finishedAt ? `完成于 ${formatDateTime(record.finishedAt)}` : record?.state === 'FAILED' ? record.error : undefined,
          }
        })}
      />
      {state.export ? (
        <Descriptions size="small" column={1} style={{ marginTop: 12 }} title="导出包">
          <Descriptions.Item label="记录行数">{formatNumber(state.export.rows)}</Descriptions.Item>
          <Descriptions.Item label="文件大小">{formatNumber(state.export.bytes / 1024 / 1024, { digits: 2 })} MB</Descriptions.Item>
          <Descriptions.Item label="校验值（SHA-256）">
            <Typography.Text copyable code style={{ fontSize: 12 }}>
              {state.export.sha256}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="保留至">{state.purged?.export ? `已于 ${formatDateTime(state.purged.export)} 清理` : formatDateTime(state.export.expiresAt)}</Descriptions.Item>
        </Descriptions>
      ) : null}
      {state.proof ? (
        <Descriptions size="small" column={1} style={{ marginTop: 12 }} title="删除证明">
          <Descriptions.Item label="完成时间">{formatDateTime(state.proof.completedAt)}</Descriptions.Item>
          <Descriptions.Item label="删除的记录">
            {formatNumber(deletedRows)} 条（{tables.length} 张表）
          </Descriptions.Item>
          <Descriptions.Item label="删除的文件">{formatNumber(state.proof.files)} 个</Descriptions.Item>
          <Descriptions.Item label="接口授权">本地已全部撤销（{formatNumber(state.proof.authorizationsRevokedLocally)} 个）；亚马逊侧的授权需企业在卖家后台人工撤销</Descriptions.Item>
          <Descriptions.Item label="审计保留至">{state.purged?.audit ? `已于 ${formatDateTime(state.purged.audit)} 清理` : '注销后 2 年'}</Descriptions.Item>
        </Descriptions>
      ) : null}
    </Card>
  )
}
