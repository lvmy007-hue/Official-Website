import { Form, Input, Select } from 'antd'
import {
  ADS_BACKFILL_MAX_SLICES,
  ADS_BACKFILL_MONTHS_DEFAULT,
  ADS_REPORT_AD_PRODUCT_LABEL,
  ADS_REPORT_AD_PRODUCTS,
  ADS_REPORT_WRITE,
  adsReportGranularityText,
  type AdsParityRunResult,
  type AdsReportBackfillResult,
  type AdsReportCreateResult,
  type AdsReportRow,
  type AdsReportTemplatesResponse,
} from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { daysBefore } from './ads-reports-data'

// 广告报表的写动作（P3-15）：创建任务、历史回补、重试、手动核对。全部只排任务，真正的取数在后台完成；成功与否以服务端为准。
// 档案没有广告账户编号（还没有发现统一接口的账户）时，选项禁用并写原因。

const MONTH_OPTIONS = [3, 6, 12, 24, 25]

const profileOptions = (data: AdsReportTemplatesResponse) =>
  data.profiles.map(profile => ({
    value: profile.id,
    disabled: !profile.ready,
    label: `${profile.name}${profile.storeName ? ` · ${profile.storeName}` : ''}${profile.ready ? '' : `（不可用：${profile.notReadyReason ?? '没有广告账户编号'}）`}`,
  }))

const productOptions = ADS_REPORT_AD_PRODUCTS.map(value => ({ value, label: ADS_REPORT_AD_PRODUCT_LABEL[value] }))
const firstReady = (data: AdsReportTemplatesResponse) => data.profiles.find(profile => profile.ready)?.id
const guardOf = (data: AdsReportTemplatesResponse | undefined) => ({
  permission: ADS_REPORT_WRITE,
  condition: { ok: Boolean(data && data.profiles.some(profile => profile.ready)), reason: data ? '没有可用的广告档案：需要先完成亚马逊广告授权并发现广告账户编号' : '正在读取广告档案' },
})

export function CreateReportAction({ data, onDone }: { data: AdsReportTemplatesResponse | undefined; onDone?: () => void }) {
  const mutation = useApiMutation<Record<string, unknown>, AdsReportCreateResult>({ method: 'POST', path: '/ads/reports', invalidate: ['list'] })
  return (
    <FormAction
      label="创建报告任务"
      title="创建报告任务"
      buttonProps={{ type: 'primary' }}
      guard={guardOf(data)}
      description="选一个模板、广告产品和起止日期，后台会向亚马逊创建报告，生成后自动下载并写入对应的指标表。单个报告的时间范围有上限（日报 120 天、小时报 14 天）。"
      initialValues={data ? { profileId: firstReady(data), templateKey: 'CAMPAIGN_DAILY', adProduct: 'SPONSORED_PRODUCTS', from: daysBefore(data.today, 29), to: data.today } : undefined}
      okText="创建"
      successText="任务已创建，正在排队"
      onDone={onDone}
      onSubmit={async values => {
        if (String(values.from) > String(values.to)) throw new Error('开始日期不能晚于结束日期')
        return mutation.mutateAsync({ profileId: values.profileId, templateKey: values.templateKey, adProduct: values.adProduct, from: values.from, to: values.to })
      }}
    >
      {data ? (
        <>
          <Form.Item name="profileId" label="广告档案" rules={[{ required: true, message: '请选择广告档案' }]}>
            <Select options={profileOptions(data)} placeholder="选择广告档案" />
          </Form.Item>
          <Form.Item name="templateKey" label="报告模板" rules={[{ required: true, message: '请选择模板' }]}>
            <Select options={data.templates.map(template => ({ value: template.key, label: `${template.label}（${adsReportGranularityText(template.granularity)}）`, title: template.description }))} />
          </Form.Item>
          <Form.Item name="adProduct" label="广告产品">
            <Select options={productOptions} />
          </Form.Item>
          <Form.Item name="from" label="开始日期" rules={[{ required: true, message: '请填写开始日期' }]}>
            <Input type="date" />
          </Form.Item>
          <Form.Item name="to" label="结束日期" rules={[{ required: true, message: '请填写结束日期' }]}>
            <Input type="date" />
          </Form.Item>
        </>
      ) : null}
    </FormAction>
  )
}

export function BackfillAction({ data, onDone }: { data: AdsReportTemplatesResponse | undefined; onDone?: () => void }) {
  const mutation = useApiMutation<Record<string, unknown>, AdsReportBackfillResult>({ method: 'POST', path: '/ads/reports/backfill', invalidate: ['list'] })
  return (
    <FormAction
      label="补历史数据"
      title="补历史数据（活动日报）"
      guard={guardOf(data)}
      description={`从今天往前取若干个月的活动日报，按 120 天切片，最多 ${ADS_BACKFILL_MAX_SLICES} 个任务。亚马逊日级数据保留 15 或 24 个月（以实测为准），取不到的更早日期不会补出来；已有数据的日期会被新数据覆盖。`}
      initialValues={data ? { profileId: firstReady(data), adProduct: 'SPONSORED_PRODUCTS', months: ADS_BACKFILL_MONTHS_DEFAULT } : undefined}
      okText="开始补数据"
      successText="历史数据任务已创建"
      onDone={onDone}
      onSubmit={values => mutation.mutateAsync({ profileId: values.profileId, adProduct: values.adProduct, months: values.months })}
    >
      {data ? (
        <>
          <Form.Item name="profileId" label="广告档案" rules={[{ required: true, message: '请选择广告档案' }]}>
            <Select options={profileOptions(data)} placeholder="选择广告档案" />
          </Form.Item>
          <Form.Item name="adProduct" label="广告产品">
            <Select options={productOptions} />
          </Form.Item>
          <Form.Item name="months" label="往前取多少个月">
            <Select options={MONTH_OPTIONS.map(value => ({ value, label: `${value} 个月` }))} />
          </Form.Item>
        </>
      ) : null}
    </FormAction>
  )
}

export function RetryAction({ row, onDone }: { row: AdsReportRow; onDone?: () => void }) {
  const mutation = useApiMutation<void, AdsReportCreateResult>({ method: 'POST', path: `/ads/reports/${encodeURIComponent(row.id)}/retry`, invalidate: ['list'] })
  return (
    <FormAction
      label="重试"
      title="重试报告任务"
      buttonProps={{ type: 'link', size: 'small', 'aria-label': `重试 ${row.title} ${row.from ?? ''}` }}
      guard={{ permission: ADS_REPORT_WRITE, condition: { ok: row.canRetry, reason: '只有新报告接口的失败任务可以重试，且每个失败任务只能重试一次' } }}
      description="按原来的模板、广告产品和时间范围新建一个任务；原任务保留失败记录。"
      okText="重试"
      successText="已新建重试任务"
      onDone={onDone}
      onSubmit={() => mutation.mutateAsync()}
    />
  )
}

export function ParityRunAction({ profileId, name, ready, onDone }: { profileId: string; name: string; ready: boolean; onDone?: () => void }) {
  const mutation = useApiMutation<void, AdsParityRunResult>({ method: 'POST', path: '/ads/parity/run', body: () => ({ profileId }), invalidate: ['list'] })
  return (
    <FormAction
      label="立即核对"
      title={`核对新旧接口：${name}`}
      buttonProps={{ type: 'link', size: 'small', 'aria-label': `立即核对 ${name}` }}
      guard={{ permission: ADS_REPORT_WRITE, condition: { ok: ready, reason: '这个档案还没有发现广告账户编号，暂时不能核对' } }}
      description="只排一个核对任务；每个档案每天最多真正核对一次，同一天重复触发不会重复跑。"
      okText="排队核对"
      successText="核对任务已排队"
      onDone={onDone}
      onSubmit={() => mutation.mutateAsync()}
    />
  )
}
