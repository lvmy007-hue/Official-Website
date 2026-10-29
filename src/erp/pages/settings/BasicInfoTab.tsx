import { useMemo } from 'react'
import { Form, Input, Select, Typography } from 'antd'
import { SETTINGS_WRITE, type EnterpriseSettingsResponse } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { formatDateTime } from '../../format'
import { CardGrid, ConfigCard, SettingsLoader, useSettingsPatch } from './settings-cards'

// 基本信息（P5-10，09 章 9.12 第 1 个页签）：企业名称与企业本地时区可改；企业标识、运行模式、数据口径时区、默认币种只读，卡片上写明由谁控制。

const MODE_LABEL: Record<string, string> = { LIVE: '正式运行' }
const CURRENCY_LABEL: Record<string, string> = { USD: '美元（USD）' }

const timezoneOptions = (current: string) => {
  const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['America/Los_Angeles', 'Asia/Shanghai']
  const all = list.includes(current) ? list : [current, ...list]
  return all.map(value => ({ value, label: value }))
}

type Basic = EnterpriseSettingsResponse['basic']

function EditName({ basic }: { basic: Basic }) {
  const patch = useSettingsPatch()
  return (
    <FormAction
      label="修改"
      title="修改企业名称"
      guard={{ permission: SETTINGS_WRITE }}
      reason={{ label: '修改原因', placeholder: '例如：公司更名' }}
      initialValues={{ name: basic.name }}
      successText="企业名称已更新"
      onSubmit={values => patch.mutateAsync({ section: 'basic', name: String(values.name ?? '').trim(), version: basic.version, reason: values.reason })}
    >
      <Form.Item
        label="企业名称"
        name="name"
        rules={[
          { required: true, whitespace: true, message: '请填写企业名称' },
          { min: 2, message: '至少 2 个字' },
        ]}
      >
        <Input aria-label="企业名称" maxLength={160} />
      </Form.Item>
    </FormAction>
  )
}

function EditLocalTimezone({ basic }: { basic: Basic }) {
  const patch = useSettingsPatch()
  const options = useMemo(() => timezoneOptions(basic.localTimezone), [basic.localTimezone])
  return (
    <FormAction
      label="修改"
      title="修改企业本地时区"
      guard={{ permission: SETTINGS_WRITE }}
      reason={{ label: '修改原因', placeholder: '例如：运营团队迁到新加坡' }}
      description="只影响日报、周报的发送时间，不改变数据统计口径。"
      initialValues={{ localTimezone: basic.localTimezone }}
      successText="企业本地时区已更新"
      onSubmit={values => patch.mutateAsync({ section: 'basic', localTimezone: values.localTimezone, version: basic.version, reason: values.reason })}
    >
      <Form.Item label="企业本地时区" name="localTimezone" rules={[{ required: true, message: '请选择时区' }]}>
        <Select aria-label="企业本地时区" showSearch options={options} />
      </Form.Item>
    </FormAction>
  )
}

function BasicCards({ data }: { data: EnterpriseSettingsResponse }) {
  const { basic } = data
  return (
    <>
      <CardGrid>
        <ConfigCard id="name" name="企业名称" value={basic.name} impact="页面顶部、通知邮件与报告里显示的企业名称。" action={<EditName basic={basic} />} />
        <ConfigCard id="localTimezone" name="企业本地时区" value={basic.localTimezone} impact="日报、周报的发送时间；不改变数据统计口径。" action={<EditLocalTimezone basic={basic} />} />
        <ConfigCard id="slug" name="企业标识" value={basic.slug} impact="登录与邀请链接里用来区分企业。" readonlyBy="创建企业时确定，不能修改；需要变更请联系平台运营。" />
        <ConfigCard
          id="mode"
          name="运行模式"
          value={MODE_LABEL[basic.mode] ?? basic.mode}
          impact="企业的运行方式标记，企业开通时确定。"
          readonlyBy="由平台运营在企业开通时设定，企业管理员不能修改。"
        />
        <ConfigCard
          id="dataTimezone"
          name="数据口径时区"
          value={basic.dataTimezone}
          impact="所有“按天”的统计（销量、费用、广告、利润）的日界线，与亚马逊后台一致。"
          readonlyBy="固定为美国太平洋时区；改动会让已汇总的日数据口径错位，所以不开放修改。"
        />
        <ConfigCard
          id="currency"
          name="默认币种"
          value={CURRENCY_LABEL[basic.defaultCurrency] ?? basic.defaultCurrency}
          impact="利润、成本与汇总金额的基准币种；其他币种按汇率折算成它。"
          readonlyBy="目前固定为美元（汇率以美元为基准）；附加币种与汇率来源在“汇率”页签里管理。"
        />
      </CardGrid>
      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
        企业资料最近更新：{formatDateTime(basic.updatedAt)}
      </Typography.Text>
    </>
  )
}

export default function BasicInfoTab() {
  return <SettingsLoader>{data => <BasicCards data={data} />}</SettingsLoader>
}
