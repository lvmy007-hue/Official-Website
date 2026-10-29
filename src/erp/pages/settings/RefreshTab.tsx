import { Alert, Form, Radio, Select, Space, Tag, Typography } from 'antd'
import { SETTINGS_WRITE, minutesText, type EnterpriseSettingsResponse, type RefreshItemView } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { CardGrid, ConfigCard, EditedNote, SettingsLoader, useSettingsPatch } from './settings-cards'

// 刷新策略（P5-10，09 章 9.12 第 4 个页签）：各数据域的定时同步频率。只能放慢或暂停，不能比系统内置的更快（保护亚马逊接口配额）；
// 手动同步、回补、写入之后的刷新不受影响。汇率获取、预警评估等固定频率的定时任务只读列出。

type Refresh = EnterpriseSettingsResponse['refresh']

function EditRefresh({ item, refresh }: { item: RefreshItemView; refresh: Refresh }) {
  const patch = useSettingsPatch()
  const current = item.override
  return (
    <FormAction
      label="调整"
      title={`调整“${item.label}”的定时同步`}
      guard={{ permission: SETTINGS_WRITE }}
      reason={{ label: '调整原因', placeholder: '例如：该数据域一天看一次就够，节省接口配额' }}
      description={`系统内置：${minutesText(item.builtInMinutes)}。只能放慢或暂停，不能更快；手动同步不受影响。`}
      initialValues={{ mode: current?.mode ?? 'DEFAULT', minutes: current?.mode === 'EVERY' ? current.minutes : item.choices[0] }}
      successText="定时同步已调整"
      onSubmit={values =>
        patch.mutateAsync({
          section: 'refresh',
          changes: { [item.key]: values.mode === 'EVERY' ? { mode: 'EVERY', minutes: values.minutes } : { mode: values.mode } },
          version: refresh.version,
          reason: values.reason,
        })
      }
    >
      <Form.Item label="同步方式" name="mode">
        <Radio.Group
          options={[
            { value: 'DEFAULT', label: `按系统内置（${minutesText(item.builtInMinutes)}）` },
            { value: 'EVERY', label: '放慢到' },
            { value: 'PAUSED', label: '暂停定时同步' },
          ]}
        />
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(prev, next) => prev.mode !== next.mode}>
        {({ getFieldValue }) =>
          getFieldValue('mode') === 'EVERY' ? (
            <Form.Item label="同步间隔" name="minutes" rules={[{ required: true, message: '请选择间隔' }]}>
              <Select aria-label="同步间隔" options={item.choices.map(minutes => ({ value: minutes, label: minutesText(minutes) }))} />
            </Form.Item>
          ) : null
        }
      </Form.Item>
    </FormAction>
  )
}

function RefreshCards({ refresh }: { refresh: Refresh }) {
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type={refresh.pausedCount > 0 ? 'warning' : 'info'}
        showIcon
        message={refresh.pausedCount > 0 ? `有 ${refresh.pausedCount} 个数据域已暂停定时同步，它们的数据不会自动更新，页面的新鲜度会变旧。` : '各数据域按系统内置的频率定时同步。'}
        description="只能放慢或暂停，不能比系统内置的更快；手动同步、回补、写入之后的刷新不受影响。放慢后的实际间隔以定时器的节拍为准，可能比设定值略短。"
      />
      <CardGrid>
        {refresh.items.map(item => (
          <ConfigCard
            key={item.key}
            id={item.key}
            name={item.label}
            value={
              <>
                {item.valueText} {item.override?.mode === 'PAUSED' ? <Tag color="warning">已暂停</Tag> : null}
              </>
            }
            impact={item.impact}
            action={<EditRefresh item={item} refresh={refresh} />}
          />
        ))}
      </CardGrid>
      <EditedNote editor={refresh} />
      <Typography.Title level={5} style={{ margin: '8px 0 0' }}>
        固定频率的定时任务
      </Typography.Title>
      <CardGrid>
        {refresh.fixed.map(item => (
          <ConfigCard
            key={item.label}
            id={`fixed-${item.label}`}
            name={item.label}
            value={item.frequency}
            impact="对应的数据或评估结果按这个频率自动更新。"
            readonlyBy="频率由系统固定，不能在页面调整。"
          />
        ))}
      </CardGrid>
    </Space>
  )
}

export default function RefreshTab() {
  return <SettingsLoader>{data => <RefreshCards refresh={data.refresh} />}</SettingsLoader>
}
