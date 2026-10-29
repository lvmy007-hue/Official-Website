import { Alert, Descriptions, InputNumber, Select, Space, Tag, Typography } from 'antd'
import {
  LENGTH_UNITS,
  LENGTH_UNIT_LABEL,
  PACKING_FIELDS,
  PACKING_FIELD_HINT,
  PACKING_FIELD_LABEL,
  PACKING_HEADER_SCAN_ROWS,
  PACKING_UNITS_SOURCE_LABEL,
  WEIGHT_UNITS,
  WEIGHT_UNIT_LABEL,
  type PackingField,
  type PackingPreviewResponse,
} from '@nova/api-contracts'
import type { PackingSettings } from './packing-list-state'

// 装箱单识别设置（P6-11）：表头在第几行、工作表、单位、没有箱规时的默认箱规、每个标准列对应哪一列。
// 没动过的项不干预（服务端按“该供应商保存的映射 → 表头里的提示 → 自动识别”处理）；改完点“重新识别”才会重新请求，不会每改一个数就刷新。

const SOURCE_TEXT = { REQUEST: '手动指定', SAVED: '保存的映射', AUTO: '自动识别' } as const
const NONE = -1

const columnLetter = (index: number) => {
  let value = index + 1
  let text = ''
  while (value > 0) {
    text = String.fromCharCode(65 + ((value - 1) % 26)) + text
    value = Math.floor((value - 1) / 26)
  }
  return text
}

function ColumnPicker({
  field,
  analysis,
  settings,
  onChange,
  disabled,
}: {
  field: PackingField
  analysis: PackingPreviewResponse
  settings: PackingSettings
  onChange: (next: PackingSettings) => void
  disabled: boolean
}) {
  const given = settings.columns[field]
  const effective = given === undefined ? (analysis.columns[field] ?? NONE) : (given ?? NONE)
  const source = given === undefined ? analysis.columnSources[field] : 'REQUEST'
  const missing = analysis.missingFields.length > 0 && (field === 'code' || field === 'name' || field === 'perBox' || field === 'totalQty') && effective === NONE
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Typography.Text style={{ width: 84 }} title={PACKING_FIELD_HINT[field]}>
        {PACKING_FIELD_LABEL[field]}
      </Typography.Text>
      <Select
        size="small"
        aria-label={`${PACKING_FIELD_LABEL[field]}对应的列`}
        style={{ width: 220 }}
        disabled={disabled}
        status={missing ? 'warning' : undefined}
        value={effective}
        options={[{ value: NONE, label: '没有这一列' }, ...analysis.headers.map((header, index) => ({ value: index, label: `${columnLetter(index)} ${header || '（空表头）'}` }))]}
        onChange={value => onChange({ ...settings, columns: { ...settings.columns, [field]: value === NONE ? null : value } })}
      />
      {effective !== NONE && source ? (
        <Tag bordered={false} color={source === 'REQUEST' ? 'blue' : source === 'SAVED' ? 'purple' : 'default'}>
          {SOURCE_TEXT[source]}
        </Tag>
      ) : null}
    </div>
  )
}

const spec = (value: number | null | undefined) => (value === null || value === undefined ? null : value)

export function PackingListSettings({
  analysis,
  settings,
  onChange,
  disabled,
}: {
  analysis: PackingPreviewResponse | null
  settings: PackingSettings
  onChange: (next: PackingSettings) => void
  disabled: boolean
}) {
  const defaults = settings.defaults
  const setDefault = (key: keyof PackingSettings['defaults'], value: number | null) => onChange({ ...settings, defaults: { ...defaults, [key]: value } })
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }} data-testid="packing-settings">
      <Space wrap size={16}>
        <label>
          表头在第几行{' '}
          <InputNumber
            size="small"
            aria-label="表头所在行"
            min={1}
            max={PACKING_HEADER_SCAN_ROWS}
            precision={0}
            disabled={disabled}
            placeholder={analysis?.headerLine ? `自动（第 ${analysis.headerLine} 行）` : '自动'}
            value={settings.headerLine}
            onChange={value => onChange({ ...settings, headerLine: value, columns: {} })}
          />
        </label>
        {analysis && analysis.sheets.length > 1 ? (
          <label>
            工作表{' '}
            <Select
              size="small"
              aria-label="工作表"
              style={{ width: 160 }}
              disabled={disabled}
              value={settings.sheet ?? analysis.sheet ?? undefined}
              options={analysis.sheets.map(name => ({ value: name, label: name }))}
              onChange={value => onChange({ ...settings, sheet: value, headerLine: null, columns: {} })}
            />
          </label>
        ) : null}
        <label>
          尺寸单位{' '}
          <Select
            size="small"
            aria-label="尺寸单位"
            style={{ width: 96 }}
            disabled={disabled}
            value={settings.units.length ?? analysis?.units.length}
            placeholder="自动"
            options={LENGTH_UNITS.map(value => ({ value, label: LENGTH_UNIT_LABEL[value] }))}
            onChange={value => onChange({ ...settings, units: { ...settings.units, length: value } })}
          />
        </label>
        <label>
          重量单位{' '}
          <Select
            size="small"
            aria-label="重量单位"
            style={{ width: 96 }}
            disabled={disabled}
            value={settings.units.weight ?? analysis?.units.weight}
            placeholder="自动"
            options={WEIGHT_UNITS.map(value => ({ value, label: WEIGHT_UNIT_LABEL[value] }))}
            onChange={value => onChange({ ...settings, units: { ...settings.units, weight: value } })}
          />
        </label>
        {analysis ? <Typography.Text type="secondary">单位依据：{PACKING_UNITS_SOURCE_LABEL[analysis.unitsSource]}</Typography.Text> : null}
      </Space>

      <div>
        <Typography.Text strong>没有箱规时的默认值（英寸、磅）</Typography.Text>
        <Typography.Paragraph type="secondary" style={{ margin: '2px 0 6px' }}>
          装箱单里没写重量或长宽高的箱子用这里的值；装箱单里有的以装箱单为准。留空表示没有默认值，缺箱规的行会被挡住。
        </Typography.Paragraph>
        <Space wrap size={12}>
          {(
            [
              ['weightLb', '重量（磅）'],
              ['lengthIn', '长（英寸）'],
              ['widthIn', '宽（英寸）'],
              ['heightIn', '高（英寸）'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}{' '}
              <InputNumber
                size="small"
                aria-label={`默认${label}`}
                min={0}
                max={100000}
                disabled={disabled}
                style={{ width: 96 }}
                value={spec(defaults[key])}
                onChange={value => setDefault(key, value)}
              />
            </label>
          ))}
        </Space>
      </div>

      {analysis && !analysis.fatal ? (
        <div>
          <Typography.Text strong>每一列对应装箱单里的哪一列</Typography.Text>
          {analysis.missingFields.length > 0 ? (
            <Alert style={{ margin: '6px 0' }} type="warning" showIcon message={`还缺少：${analysis.missingFields.join('、')}`} description="在下面选出对应的列，再点“重新识别”。" />
          ) : null}
          {analysis.missingSaved.length > 0 ? (
            <Alert style={{ margin: '6px 0' }} type="info" showIcon message={`该供应商保存的映射里，这些列在这份文件里找不到表头：${analysis.missingSaved.join('、')}`} />
          ) : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 6, marginTop: 6 }}>
            {PACKING_FIELDS.map(field => (
              <ColumnPicker key={field} field={field} analysis={analysis} settings={settings} onChange={onChange} disabled={disabled} />
            ))}
          </div>
        </div>
      ) : null}

      {analysis ? (
        <Descriptions
          size="small"
          column={3}
          items={[
            { key: 'h', label: '表头行', children: analysis.headerLine ? `第 ${analysis.headerLine} 行` : '尚无记录' },
            { key: 'm', label: '该供应商的列映射', children: analysis.savedMapping ? '已保存' : '尚未保存' },
            { key: 's', label: '跳过的行', children: `${analysis.skipped.length} 行` },
          ]}
        />
      ) : null}
    </Space>
  )
}
