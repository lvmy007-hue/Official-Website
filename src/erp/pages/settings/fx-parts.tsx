import { Form, Input, InputNumber, Select, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { FX_CURVE_MAX_DAYS } from '@nova/api-contracts'
import { FormAction, SimpleGrid } from '../../components'
import { formatDate, formatDateTime } from '../../format'

export type LatestRate = { currency: string; rateDate: string | null; rate: number | null; source: string | null; isFallback: boolean; isManualOverride: boolean }
export type CurvePoint = { date: string; rate: number; source: string; isFallback: boolean; isManualOverride: boolean }
export type SourceRow = {
  role: 'PRIMARY' | 'BACKUP'
  provider: string
  providerLabel: string
  pathTemplate: string
  configured: boolean
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastStatus: string | null
  lastErrorCode: string | null
  consecutiveFailures: number
}
export type OverrideRow = { id: string; quoteCurrency: string; rateDate: string; rate: number; reason: string | null; overriddenBy: string | null; createdAt: string; locked: boolean }
export type FxOverview = {
  baseCurrency: string
  currencies: string[]
  extraCurrencies: string[]
  quote: string
  days: number
  latest: LatestRate[]
  curve: CurvePoint[]
  sources: SourceRow[]
  providers: Array<{ key: string; label: string; template: string }>
  overrides: OverrideRow[]
}

export const WRITE = 'settings.fx.write'
export const FX_ERROR_LABEL: Record<string, string> = {
  SOURCE_URL_INVALID: '来源地址不合规，已拒绝请求',
  TIMEOUT: '请求超时',
  NETWORK_ERROR: '网络不通',
  RESPONSE_INVALID: '返回内容无法识别',
  RESPONSE_TOO_LARGE: '返回内容过大',
}
export const errorText = (code: string | null) => (code ? (FX_ERROR_LABEL[code] ?? (code.startsWith('HTTP_') ? `来源返回错误（${code.slice(5)}）` : code)) : null)

const SOURCE_LABEL = { PRIMARY: '主源', BACKUP: '备源' } as const

export function latestColumns(providerLabel: (key: string | null) => string): ColumnsType<LatestRate> {
  return [
    { title: '币种', dataIndex: 'currency', width: 90 },
    { title: `1 美元折合`, key: 'rate', render: (_, row) => (row.rate === null ? '尚无汇率' : <span className="erp-num">{row.rate}</span>) },
    { title: '日期', key: 'date', width: 120, render: (_, row) => (row.rateDate ? formatDate(row.rateDate, { timeZone: 'UTC' }) : '—') },
    { title: '来源', key: 'source', render: (_, row) => (row.isManualOverride ? '手工覆盖' : providerLabel(row.source)) },
    {
      title: '说明',
      key: 'flags',
      render: (_, row) => (
        <Space size={4}>
          {row.isManualOverride ? <Tag color="blue">手工覆盖</Tag> : null}
          {row.isFallback ? <Tag color="warning">沿用最近牌价（当天无牌价）</Tag> : null}
        </Space>
      ),
    },
  ]
}

export function SourceCards({ sources }: { sources: SourceRow[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
      {sources.map(source => {
        const failed = source.lastStatus === 'FAILED'
        return (
          <div key={source.role} style={{ border: '1px solid var(--ant-color-border-secondary)', borderRadius: 8, padding: 12 }}>
            <Space>
              <strong>{SOURCE_LABEL[source.role]}</strong>
              <span>{source.providerLabel}</span>
              {source.lastStatus === null ? <Tag>尚未获取</Tag> : failed ? <Tag color="error">最近失败</Tag> : <Tag color="success">最近成功</Tag>}
            </Space>
            <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)', marginTop: 6, wordBreak: 'break-all' }}>{source.pathTemplate}</div>
            <div style={{ fontSize: 12, marginTop: 6 }}>
              最近尝试：{source.lastAttemptAt ? formatDateTime(source.lastAttemptAt) : '尚无'}；最近成功：{source.lastSuccessAt ? formatDateTime(source.lastSuccessAt) : '尚无'}
            </div>
            {failed ? (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                失败原因：{errorText(source.lastErrorCode)}（已连续失败 {source.consecutiveFailures} 次）
              </Typography.Text>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export function OverrideTable({ overview, onRemove, onDone }: { overview: FxOverview; onRemove: (id: string) => Promise<unknown>; onDone: () => void }) {
  const columns: ColumnsType<OverrideRow> = [
    { title: '币种', dataIndex: 'quoteCurrency', width: 80 },
    { title: '日期', dataIndex: 'rateDate', width: 120 },
    { title: '汇率', dataIndex: 'rate', width: 120 },
    { title: '原因', dataIndex: 'reason', ellipsis: true },
    { title: '操作人', dataIndex: 'overriddenBy', width: 110, render: (value: string | null) => value ?? '—' },
    { title: '时间', dataIndex: 'createdAt', width: 150, render: (value: string) => formatDateTime(value) },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_, row) => (
        <FormAction
          label={row.locked ? '已关账锁定' : '撤销覆盖'}
          guard={{ permission: WRITE, condition: { ok: !row.locked, reason: '该日汇率已被已关账的期间锁定，不能撤销；如确需调整，请先由财务重新开账' } }}
          title="撤销手工覆盖"
          description={`撤销后，${row.rateDate} 的 ${row.quoteCurrency} 汇率恢复为系统获取的汇率；已有的利润计算会在下次刷新时按新汇率重算。`}
          stepUp="fx.write"
          okText="撤销"
          danger
          onSubmit={() => onRemove(row.id)}
          successText="已撤销手工覆盖"
          onDone={onDone}
          buttonProps={{ size: 'small' }}
        />
      ),
    },
  ]
  return (
    <SimpleGrid<OverrideRow>
      gridId="settings.fx-parts"
      columns={columns}
      rows={overview.overrides}
      rowKey={row => row.id}
      emptyState={{ kind: 'empty', domain: '手工覆盖记录', prerequisite: '还没有手工覆盖过汇率；系统获取的汇率不满足需要时可以手工覆盖某一天。' }}
    />
  )
}

const today = () => new Date().toISOString().slice(0, 10)

/** 手工覆盖某一天的汇率（表单项）。 */
export function OverrideFields({ currencies }: { currencies: string[] }) {
  return (
    <>
      <Form.Item label="币种" name="quoteCurrency" rules={[{ required: true, message: '请选择币种' }]}>
        <Select options={currencies.map(item => ({ value: item, label: item }))} placeholder="选择要覆盖的币种" />
      </Form.Item>
      <Form.Item label="日期" name="rateDate" rules={[{ required: true, message: '请选择日期' }]} extra={`只能覆盖最近 ${FX_CURVE_MAX_DAYS} 天内、不晚于今天的汇率`}>
        <Input type="date" max={today()} style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="汇率（1 美元折合）" name="rate" rules={[{ required: true, message: '请输入汇率' }]} extra="最多 8 位小数，必须大于 0">
        <InputNumber min={0} max={1_000_000} step={0.0001} precision={8} stringMode={false} style={{ width: 200 }} />
      </Form.Item>
    </>
  )
}

/** 选择主源与备源（表单项）：两个来源不能相同。 */
export function SourceFields({ providers }: { providers: FxOverview['providers'] }) {
  const options = providers.map(item => ({ value: item.key, label: item.label }))
  return (
    <>
      <Form.Item label="主源" name="primary" rules={[{ required: true, message: '请选择主源' }]}>
        <Select options={options} />
      </Form.Item>
      <Form.Item
        label="备源"
        name="backup"
        dependencies={['primary']}
        rules={[
          { required: true, message: '请选择备源' },
          ({ getFieldValue }) => ({ validator: (_rule, value) => (value && value === getFieldValue('primary') ? Promise.reject(new Error('主源与备源不能选同一个来源')) : Promise.resolve()) }),
        ]}
        extra="来源地址使用该来源的默认地址；主源失败时才会用备源。"
      >
        <Select options={options} />
      </Form.Item>
    </>
  )
}

/** 管理附加币种（表单项）：人民币默认必有，这里设置采购或费用用到的其他币种。 */
export function CurrencyFields() {
  return (
    <Form.Item label="附加币种" name="currencies" extra="输入 3 位币种代码后回车，例如 EUR、GBP；人民币默认包含；美元是基准币种不需要添加。">
      <Select mode="tags" tokenSeparators={[',', ' ']} style={{ width: '100%' }} maxCount={12} />
    </Form.Item>
  )
}
