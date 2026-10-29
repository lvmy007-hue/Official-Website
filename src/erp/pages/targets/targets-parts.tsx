import type { ReactNode } from 'react'
import { Form, Input, InputNumber, Select, Space, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  TARGET_DIMENSIONS,
  TARGET_DIMENSION_LABEL,
  TARGET_METRICS,
  TARGET_METRIC_LABEL,
  TARGET_PACE_MODES,
  TARGET_PACE_MODE_LABEL,
  type TargetDimension,
  type TargetHistoryItem,
  type TargetProgress,
  type TargetRow,
} from '@nova/api-contracts'
import { EstimateTag, type TimelineEvent } from '../../components'
import { formatMoney, formatPercent } from '../../format'

// 目标与预算网格的展示与表单部件（P2a-04，拆出来避免 TargetsPage.tsx 超过行数上限）。

export const WRITE = 'targets.write'

const PROGRESS_STATE_LABEL: Record<Exclude<TargetProgress['state'], 'OK'>, string> = { NOT_SET: '尚未设置', RESTRICTED: '无权查看', NOT_CONNECTED: '尚未接入' }

function ProgressCell({ progress }: { progress: TargetProgress }) {
  if (progress.state !== 'OK') {
    return (
      <Space direction="vertical" size={0}>
        <Typography.Text type={progress.state === 'RESTRICTED' ? 'secondary' : undefined}>{PROGRESS_STATE_LABEL[progress.state]}</Typography.Text>
        {progress.note ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {progress.note}
          </Typography.Text>
        ) : null}
      </Space>
    )
  }
  return (
    <Space direction="vertical" size={0}>
      <span>
        已实际 {formatMoney(progress.actualToDate, 'USD', { digits: 0 })}
        {progress.expectedToDate === null ? null : <>（目标节奏应完成 {formatMoney(progress.expectedToDate, 'USD', { digits: 0 })}）</>}
        {progress.achievementRatio === null ? null : <> · 达成 {formatPercent(progress.achievementRatio, { digits: 1 })}</>}
      </span>
      {progress.forecast ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <EstimateTag method="近 7 天日均/最低/最高 × 剩余天数" /> 预测 {formatMoney(progress.forecast.median, 'USD', { digits: 0 })}，缺口 {formatMoney(progress.forecast.gap, 'USD', { digits: 0 })}
        </Typography.Text>
      ) : null}
      {progress.paceFallback ? (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          {progress.note}
        </Typography.Text>
      ) : null}
    </Space>
  )
}

export function gridColumns(renderAction: (row: TargetRow) => ReactNode, showDimension: boolean): ColumnsType<TargetRow> {
  const base: ColumnsType<TargetRow> = []
  if (showDimension) {
    base.push({ title: '维度', key: 'dimension', width: 160, render: (_, row) => `${TARGET_DIMENSION_LABEL[row.dimension]} · ${row.dimensionRef}` })
  }
  base.push(
    { title: '指标', key: 'metric', width: 100, render: (_, row) => TARGET_METRIC_LABEL[row.metric] },
    {
      title: '目标值',
      key: 'targetValue',
      width: 130,
      render: (_, row) => (row.targetValue === null ? <Typography.Text type="secondary">尚未设置</Typography.Text> : <span className="erp-num">{row.targetValue.toLocaleString('en-US')}</span>),
    },
    { title: '节奏', key: 'paceMode', width: 110, render: (_, row) => (row.targetValue === null ? '—' : TARGET_PACE_MODE_LABEL[row.paceMode]) },
    { title: '达成进度 / 预测达成', key: 'progress', render: (_, row) => <ProgressCell progress={row.progress} /> },
    { title: '操作', key: 'action', width: 110, render: (_, row) => renderAction(row) },
  )
  return base
}

/** 编辑目标值的表单项：维度与指标固定展示，只能改目标值、节奏与备注。 */
export function EditTargetFields({ row }: { row: TargetRow }) {
  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {TARGET_DIMENSION_LABEL[row.dimension]} · {row.dimensionRef} · {TARGET_METRIC_LABEL[row.metric]}
      </Typography.Paragraph>
      <Form.Item label="目标值" name="targetValue" rules={[{ required: true, message: '请输入目标值' }]}>
        <InputNumber min={0} max={1e15} step={1} style={{ width: 220 }} />
      </Form.Item>
      <Form.Item label="节奏线" name="paceMode" extra="历史季节曲线取近 2 年同月的日占比；历史数据不足时按天均摊并提示。">
        <Select options={TARGET_PACE_MODES.map(value => ({ value, label: TARGET_PACE_MODE_LABEL[value] }))} />
      </Form.Item>
      <Form.Item label="备注" name="note">
        <Input.TextArea rows={2} maxLength={500} showCount />
      </Form.Item>
    </>
  )
}

const CUSTOM_DIMENSIONS = TARGET_DIMENSIONS.filter((dimension): dimension is Exclude<TargetDimension, 'STORE'> => dimension !== 'STORE')

/** 新增细化目标（类目或 ASIN 组）的表单项。 */
export function NewCustomTargetFields() {
  const dimension = Form.useWatch('dimension')
  return (
    <>
      <Form.Item label="维度" name="dimension" rules={[{ required: true }]}>
        <Select options={CUSTOM_DIMENSIONS.map(value => ({ value, label: TARGET_DIMENSION_LABEL[value] }))} />
      </Form.Item>
      <Form.Item
        label={dimension === 'CATEGORY' ? '类目路径' : 'ASIN 组'}
        name="dimensionRef"
        rules={[{ required: true, message: '请填写类目路径或 ASIN 组' }]}
        extra={dimension === 'CATEGORY' ? '例如：家居 > 收纳' : '多个 ASIN 用逗号分隔，例如 B0XXXXXXX1,B0XXXXXXX2'}
      >
        <Input />
      </Form.Item>
      <Form.Item label="指标" name="metric" rules={[{ required: true }]} extra={dimension === 'ASIN' ? 'ASIN 组目前不支持“订单数”（日汇总没有按 ASIN 的订单字段）' : undefined}>
        <Select options={TARGET_METRICS.filter(metric => !(dimension === 'ASIN' && metric === 'ORDERS')).map(value => ({ value, label: TARGET_METRIC_LABEL[value] }))} />
      </Form.Item>
      <Form.Item label="目标值" name="targetValue" rules={[{ required: true, message: '请输入目标值' }]}>
        <InputNumber min={0} max={1e15} step={1} style={{ width: 220 }} />
      </Form.Item>
      <Form.Item label="节奏线" name="paceMode" initialValue="LINEAR">
        <Select options={TARGET_PACE_MODES.map(value => ({ value, label: TARGET_PACE_MODE_LABEL[value] }))} />
      </Form.Item>
      <Form.Item label="备注" name="note">
        <Input.TextArea rows={2} maxLength={500} showCount />
      </Form.Item>
    </>
  )
}

export function historyEvents(items: readonly TargetHistoryItem[]): TimelineEvent[] {
  return items.map(item => ({ id: item.id, at: item.at, kind: 'budget', title: item.title, origin: 'system', actor: item.actor ?? undefined }))
}
