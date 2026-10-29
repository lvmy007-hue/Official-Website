import { Alert, Button, Space, Spin, Tag, Typography } from 'antd'
import type { AdsWritePreviewItem, AdsWritePreviewResponse } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'

// 广告写入的写前预览面板（P3-17，09 章 9.13）：逐项显示修改前、修改后、变化幅度与提醒，列出开关状态；
// 不能提交的原因（没有权限、没有广告授权、开关关闭、对象不存在、取值不合法）写在最上面。预览只读本系统的数据，不调用亚马逊。

const percentText = (value: number | null) => (value === null ? '—' : `${value > 0 ? '+' : ''}${value}%`)

function forecastText(item: AdsWritePreviewItem): string | null {
  const forecast = item.forecast
  if (!forecast) return null
  return forecast.state === 'OK' ? `官方预测：${forecast.note}` : forecast.note
}

export function PreviewPanel({
  data,
  loading,
  error,
  stale,
  onPreview,
  blocked,
}: {
  data: AdsWritePreviewResponse | null
  loading: boolean
  error: string | null
  /** 已有预览但表单取值又改了：需要重新预览。 */
  stale: boolean
  onPreview: () => void
  /** 表单还不完整时的提示（不能预览）。 */
  blocked: string | null
}) {
  return (
    <div data-testid="ads-write-preview">
      <Space style={{ marginBottom: 8 }}>
        <Button onClick={onPreview} loading={loading} disabled={blocked !== null}>
          预览修改
        </Button>
        {blocked ? <Typography.Text type="secondary">{blocked}</Typography.Text> : null}
        {stale && data ? <Typography.Text type="warning">取值已修改，请重新预览</Typography.Text> : null}
      </Space>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}
      {loading && !data ? <Spin /> : null}
      {data && !stale ? (
        <>
          <Alert
            type={data.canSubmit ? 'success' : 'warning'}
            showIcon
            style={{ marginBottom: 8 }}
            message={data.canSubmit ? '预览通过，可以提交' : (data.reason ?? '不能提交')}
            description={data.note}
            data-testid="ads-write-preview-verdict"
          />
          <SimpleGrid<AdsWritePreviewItem>
            gridId="advertising.ads-write-preview"
            columns={[
              { title: '对象', render: (_: unknown, item) => item.entityLabel ?? item.entityId },
              { title: '修改', dataIndex: 'kindLabel' },
              { title: '修改前', render: (_: unknown, item) => item.before ?? '尚未同步' },
              { title: '修改后', dataIndex: 'after' },
              { title: '变化', render: (_: unknown, item) => percentText(item.changePercent) },
              {
                title: '提醒',
                render: (_: unknown, item) => {
                  const lines = [item.blocker, ...item.warnings, forecastText(item)].filter((line): line is string => Boolean(line))
                  return lines.length === 0 ? '—' : lines.map(line => <div key={line}>{line}</div>)
                },
              },
            ]}
            rows={data.items}
            rowKey={item => String(item.index)}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
          />
          <Space wrap style={{ marginTop: 8 }}>
            {data.switches.map(item => (
              <Tag key={item.key} color={item.enabled ? 'green' : 'red'}>
                {item.label}：{item.enabled ? '已开启' : (item.reason ?? '未开启')}
              </Tag>
            ))}
          </Space>
        </>
      ) : null}
    </div>
  )
}
