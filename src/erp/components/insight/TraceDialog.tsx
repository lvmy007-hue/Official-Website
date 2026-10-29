import { Descriptions, Modal, Tag, Typography } from 'antd'
import { AppLink } from '../../nav/AppLink'
import { formatDateTime } from '../../format'
import { DataState } from '../data-state/DataState'
import { stateFromError } from '../data-state/from-error'
import { describeError } from '../../query/errors'

// 可追溯弹层（03 章 3.4 第 1 项）：点击任一数字，显示口径、公式、来源接口或报告、来源记录（可跳转）、同步时间、数据质量标记。

export type TraceInfo = {
  metric: string
  definition: string
  formula?: string
  /** 来源接口或报告的中文名称。 */
  source: string
  /** 来源记录：可跳转到对应对象。 */
  records: Array<{ label: string; href?: string }>
  syncedAt: string | null
  quality: { level: 'ok' | 'warning' | 'error'; notes: string[] }
  definitionVersion: string
}

const QUALITY_LABEL = { ok: '数据正常', warning: '存在提示', error: '存在问题' } as const
const QUALITY_COLOR = { ok: 'success', warning: 'warning', error: 'error' } as const

export function TraceDialog(props: { open: boolean; onClose: () => void; loading?: boolean; error?: unknown; onRetry?: () => void; info?: TraceInfo | null }) {
  const { info } = props
  return (
    <Modal open={props.open} onCancel={props.onClose} footer={null} title={info ? `追溯：${info.metric}` : '数字追溯'} width={560} destroyOnClose>
      {props.error ? (
        <DataState {...stateFromError(describeError(props.error), { onRetry: props.onRetry })} />
      ) : props.loading || !info ? (
        <DataState kind="skeleton" rows={4} />
      ) : (
        <Descriptions column={1} size="small" bordered labelStyle={{ width: 110 }}>
          <Descriptions.Item label="口径">
            {info.definition}
            <div>
              <Typography.Text type="secondary">口径版本 {info.definitionVersion}</Typography.Text>
            </div>
          </Descriptions.Item>
          {info.formula ? <Descriptions.Item label="公式">{info.formula}</Descriptions.Item> : null}
          <Descriptions.Item label="来源">{info.source}</Descriptions.Item>
          <Descriptions.Item label="来源记录">
            {info.records.length === 0 ? (
              '无单条来源记录（汇总口径）'
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {info.records.map(record => (
                  <li key={record.label}>{record.href ? <AppLink to={record.href}>{record.label}</AppLink> : record.label}</li>
                ))}
              </ul>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="同步时间">{info.syncedAt ? formatDateTime(info.syncedAt) : '尚无成功同步记录'}</Descriptions.Item>
          <Descriptions.Item label="数据质量">
            <Tag color={QUALITY_COLOR[info.quality.level]} bordered={false}>
              {QUALITY_LABEL[info.quality.level]}
            </Tag>
            {info.quality.notes.map(note => (
              <div key={note}>{note}</div>
            ))}
          </Descriptions.Item>
        </Descriptions>
      )}
    </Modal>
  )
}
