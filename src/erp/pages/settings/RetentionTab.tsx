import { Alert, Form, InputNumber, Space, Tag } from 'antd'
import { SETTINGS_WRITE, type EnterpriseSettingsResponse, type RetentionItemView, type RetentionPolicy } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { CardGrid, ConfigCard, EditedNote, SettingsLoader, useSettingsPatch } from './settings-cards'

// 数据保留（P5-10，09 章 9.12 第 3 个页签）：原始报告文件、导出文件、买家信息三项可改；审计日志固定不能改，只读说明。
// 修改只对之后新产生的数据生效，已有数据的到期时间不变（每张卡片写明）。

type Retention = EnterpriseSettingsResponse['retention']

const currentPolicy = (retention: Retention): RetentionPolicy => {
  const out = {} as Record<string, number>
  for (const item of retention.items) out[item.key] = item.days
  return out as RetentionPolicy
}

function EditRetention({ item, retention }: { item: RetentionItemView; retention: Retention }) {
  const patch = useSettingsPatch()
  return (
    <FormAction
      label="修改"
      title={`修改“${item.label}”的保留天数`}
      guard={{ permission: SETTINGS_WRITE }}
      reason={{ label: '修改原因', placeholder: '例如：合规团队要求缩短买家信息的保留期' }}
      description={item.appliesTo}
      initialValues={{ days: item.days }}
      successText="保留天数已更新"
      onSubmit={values => patch.mutateAsync({ section: 'retention', values: { ...currentPolicy(retention), [item.key]: values.days }, version: retention.version, reason: values.reason })}
    >
      <Form.Item
        label="保留天数"
        name="days"
        extra={`可设 ${item.minDays} 至 ${item.maxDays} 天；系统默认 ${item.defaultDays} 天`}
        rules={[
          { required: true, message: '请填写保留天数' },
          { type: 'number', min: item.minDays, max: item.maxDays, message: `应在 ${item.minDays} 至 ${item.maxDays} 之间` },
        ]}
      >
        <InputNumber aria-label="保留天数" min={item.minDays} max={item.maxDays} precision={0} addonAfter="天" style={{ width: 200 }} />
      </Form.Item>
    </FormAction>
  )
}

function RetentionCards({ retention }: { retention: Retention }) {
  const audit = retention.auditLog
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert type="info" showIcon message="修改只对之后新产生的数据生效，已有数据的到期时间不变；每次修改都会记入审计日志。" />
      <CardGrid>
        {retention.items.map(item => (
          <ConfigCard
            key={item.key}
            id={item.key}
            name={item.label}
            value={
              <>
                {item.days} 天 {item.isDefault ? <Tag>系统默认</Tag> : null}
              </>
            }
            impact={item.impact}
            note={`${item.description}${item.appliesTo}`}
            action={<EditRetention item={item} retention={retention} />}
          />
        ))}
        <ConfigCard id="auditLog" name={audit.label} value={audit.value} impact={audit.impact} note={audit.description} readonlyBy={audit.controlledBy} />
      </CardGrid>
      <EditedNote editor={retention} />
    </Space>
  )
}

export default function RetentionTab() {
  return <SettingsLoader>{data => <RetentionCards retention={data.retention} />}</SettingsLoader>
}
