import { Alert, Descriptions, Image, Segmented, Select, Space } from 'antd'
import { BA_PERIOD_LABEL, type BaPeriod, type Asin360ContentResponse, Asin360Fact, Asin360ListingResponse, Asin360ReviewsResponse, Asin360Section } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { QueryBody, useProductQuery } from './asin360-hooks'
import { AplusBlock, ReviewsBlocks } from './asin360-reviews'

// ASIN 360 刊登与问题、评价与反馈、内容与 A+ 三个页签（05 章 5.2，P4-08）。
// 这三个页签的数据来源大多还没有接入：有的字段（商品目录同步写入的资料）给真实值，没有来源的区块逐项写明“尚未接入”与负责的工作包，不显示 0、不拿示例数字代替。

/** 没有数据来源的区块：说明原因与负责的工作包；没有工作包的是官方接口本身没有这项数据。 */
export function PendingSections({ sections }: { sections: readonly Asin360Section[] }) {
  if (sections.length === 0) return null
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }} data-testid="asin360-pending">
      {sections.map(section => (
        <Alert
          key={section.key}
          type="info"
          showIcon
          message={`${section.title}：尚未接入`}
          description={`${section.note}${section.workPackage ? `（由 ${section.workPackage} 交付）` : '（官方接口没有这项数据，不会交付）'}`}
          data-testid={`asin360-pending-${section.key}`}
        />
      ))}
    </Space>
  )
}

export interface PeriodChoice {
  period: BaPeriod
  periodStart: string | undefined
}

/** 品牌分析周期选择：先选周、月、季，再选已有数据的周期起始日（不选取最近一期）。 */
export function PeriodPicker({ value, available, onChange }: { value: PeriodChoice; available: readonly string[]; onChange: (next: PeriodChoice) => void }) {
  return (
    <Space size={8} wrap data-testid="asin360-period-picker">
      <Segmented<BaPeriod>
        size="small"
        value={value.period}
        options={(Object.keys(BA_PERIOD_LABEL) as BaPeriod[]).map(key => ({ value: key, label: BA_PERIOD_LABEL[key] }))}
        onChange={period => onChange({ period, periodStart: undefined })}
      />
      <Select
        size="small"
        style={{ minWidth: 150 }}
        aria-label="周期起始日"
        placeholder="最近一期"
        allowClear
        value={value.periodStart}
        options={available.map(start => ({ value: start, label: start }))}
        onChange={periodStart => onChange({ period: value.period, periodStart })}
      />
    </Space>
  )
}

function factValue(fact: Asin360Fact) {
  if (fact.value === null) return <Muted>尚无记录</Muted>
  return fact.kind === 'time' ? formatDateTime(fact.value) : fact.value
}

/** 已同步到的刊登资料与内容字段（没有取值的写“尚无记录”）。 */
export function FactsTable({ facts, testId }: { facts: readonly Asin360Fact[]; testId: string }) {
  return (
    <Descriptions size="small" bordered column={{ xs: 1, md: 2 }} data-testid={testId}>
      {facts.map(fact => (
        <Descriptions.Item key={fact.label} label={fact.label}>
          {factValue(fact)}
        </Descriptions.Item>
      ))}
    </Descriptions>
  )
}

export function ListingTab({ id }: { id: string }) {
  const query = useProductQuery<Asin360ListingResponse>(id, 'listing')
  return (
    <QueryBody query={query}>
      {data => (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <FactsTable facts={data.facts} testId="asin360-listing-facts" />
          <PendingSections sections={data.pending} />
          <Muted>{data.basis}</Muted>
        </Space>
      )}
    </QueryBody>
  )
}

export function ReviewsTab({ id }: { id: string }) {
  const query = useProductQuery<Asin360ReviewsResponse>(id, 'reviews')
  return (
    <QueryBody query={query}>
      {data => (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <ReviewsBlocks data={data} />
          <PendingSections sections={data.pending} />
          <Muted>{data.basis}</Muted>
        </Space>
      )}
    </QueryBody>
  )
}

export function ContentTab({ id }: { id: string }) {
  const query = useProductQuery<Asin360ContentResponse>(id, 'content')
  return (
    <QueryBody query={query}>
      {data => (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {data.imageUrl ? <Image src={data.imageUrl} alt="商品主图" width={120} /> : <Muted>主图：尚无记录</Muted>}
          <FactsTable facts={data.facts} testId="asin360-content-facts" />
          <AplusBlock aplus={data.aplus} />
          <PendingSections sections={data.pending} />
          <Muted>{data.basis}</Muted>
        </Space>
      )}
    </QueryBody>
  )
}
