import { Card, Descriptions, Space, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { Asin360AplusItem, Asin360CategoryTopicRow, Asin360ReviewsResponse, Asin360ReviewTopic } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { percentText } from '../analytics/brand-options'
import { Muted, StateBlock } from '../inventory/inventory-ui'

// ASIN 360 评价与反馈、内容与 A+ 页签接入已有数据的区块（P6-21）：评分（文件导入）、评论主题（P4-13）、类目对比、A+ 内容（P4-14）。
// 缺的值写“尚无记录”，不写 0；没有数据的区块用 StateBlock 写明原因。

const dash = <Muted>尚无记录</Muted>
const rate = (value: number | null) => (value === null ? dash : percentText(value))
const topicColumns: ColumnsType<Asin360ReviewTopic> = [
  { title: '名次', dataIndex: 'rank', width: 60 },
  { title: '主题', dataIndex: 'topicKey' },
  { title: '提及量（接口区间）', dataIndex: 'mentionRange', render: (value: string | null) => value ?? dash },
  { title: '评论数档位', dataIndex: 'reviewCountBucket', render: (value: string | null) => value ?? dash },
]
const categoryColumns: ColumnsType<Asin360CategoryTopicRow> = [
  { title: '主题', dataIndex: 'topicKey' },
  { title: '倾向', dataIndex: 'sentiment', width: 70, render: (value: string) => <Tag color={value === 'POSITIVE' ? 'green' : 'red'}>{value === 'POSITIVE' ? '正面' : '负面'}</Tag> },
  { title: '本商品名次', dataIndex: 'productRank', width: 100, render: (value: number | null) => value ?? dash },
  { title: '类目全部商品', dataIndex: 'allRate', render: rate },
  { title: '上月', dataIndex: 'allPrevious', render: rate },
  { title: '类目前 25% 商品', dataIndex: 'top25Rate', render: rate },
  { title: '上月', dataIndex: 'top25Previous', render: rate },
]
const aplusColumns: ColumnsType<Asin360AplusItem> = [
  { title: 'A+ 内容', dataIndex: 'name' },
  { title: '审核状态', dataIndex: 'status', width: 110 },
  { title: '语言', dataIndex: 'locale', width: 80 },
  { title: '上线时间', dataIndex: 'publishedAt', render: (value: string | null) => (value ? formatDateTime(value) : dash) },
  { title: '拒绝原因', dataIndex: 'rejectionReason', render: (value: string | null) => value ?? dash },
]

export function ReviewsBlocks({ data }: { data: Asin360ReviewsResponse }) {
  const { rating, topics, category } = data
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Card size="small" title={`评分与评分数（来源：${rating.sourceLabel}）`} data-testid="asin360-reviews-rating">
        <StateBlock state={rating.state} note={rating.note}>
          {rating.latest ? (
            <Descriptions size="small" bordered column={{ xs: 1, md: 3 }}>
              <Descriptions.Item label="平均评分">{rating.latest.avgRating ?? dash}</Descriptions.Item>
              <Descriptions.Item label="评分数">{rating.latest.ratingCount ?? dash}</Descriptions.Item>
              <Descriptions.Item label="采集日期">{rating.latest.date}</Descriptions.Item>
              <Descriptions.Item label="星级分布" span={2}>
                {rating.latest.distribution
                  ? Object.entries(rating.latest.distribution)
                      .map(([star, count]) => `${star} 星 ${count}`)
                      .join('；')
                  : dash}
              </Descriptions.Item>
              <Descriptions.Item label="来源文件">{rating.latest.sourceFileName}</Descriptions.Item>
            </Descriptions>
          ) : null}
          {rating.points.length > 1 ? (
            <Muted>
              最近 {rating.points.length} 个采集点：{rating.points.map(point => `${point.date} ${point.avgRating ?? '无'}`).join('；')}
            </Muted>
          ) : null}
        </StateBlock>
      </Card>
      <Card size="small" title={`评论主题${topics.snapshotDate ? `（${topics.snapshotDate}）` : ''}`} data-testid="asin360-reviews-topics">
        <StateBlock state={topics.state} note={topics.note}>
          <Muted>正面主题</Muted>
          <SimpleGrid<Asin360ReviewTopic>
            gridId="products.asin360-reviews"
            columns={topicColumns}
            rows={topics.positive}
            rowKey={row => `p${row.rank}`}
            emptyState={{ kind: 'empty', domain: '正面主题', prerequisite: '这一期没有正面主题。' }}
          />
          <Muted>负面主题</Muted>
          <SimpleGrid<Asin360ReviewTopic>
            gridId="products.asin360-reviews-2"
            columns={topicColumns}
            rows={topics.negative}
            rowKey={row => `n${row.rank}`}
            emptyState={{ kind: 'empty', domain: '负面主题', prerequisite: '这一期没有负面主题。' }}
          />
        </StateBlock>
      </Card>
      <Card size="small" title={`与类目对比${category.browseNodeName ? `（${category.browseNodeName}）` : ''}`} data-testid="asin360-reviews-category">
        <StateBlock state={category.state} note={category.note}>
          <Muted>
            {category.month} 与上月{category.previousMonth ? `（${category.previousMonth}）` : '（没有数据）'}的主题占比
          </Muted>
          <SimpleGrid<Asin360CategoryTopicRow>
            gridId="products.asin360-reviews-3"
            columns={categoryColumns}
            rows={category.rows}
            rowKey={row => `${row.sentiment}-${row.topicKey}`}
            emptyState={{ kind: 'empty', domain: '类目对比', prerequisite: '没有可对比的主题。' }}
          />
        </StateBlock>
      </Card>
    </Space>
  )
}

export function AplusBlock({ aplus }: { aplus: { state: 'OK' | 'NO_DATA'; note: string | null; items: Asin360AplusItem[]; truncated: boolean } }) {
  return (
    <Card size="small" title="A+ 内容" data-testid="asin360-content-aplus">
      <StateBlock state={aplus.state} note={aplus.note}>
        <SimpleGrid<Asin360AplusItem>
          gridId="products.asin360-reviews-4"
          columns={aplusColumns}
          rows={aplus.items}
          rowKey={row => row.contentId}
          emptyState={{ kind: 'empty', domain: 'A+ 内容', prerequisite: aplus.note ?? '没有关联的 A+ 内容。' }}
        />
        {aplus.truncated ? <Muted>只列出最近更新的 20 条</Muted> : null}
      </StateBlock>
    </Card>
  )
}
