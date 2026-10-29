import { describe, expect, it } from 'vitest'
import { REVIEWS_LIMITS, REVIEWS_TABS, REVIEW_SORTS, SOLICITATION_STATUSES, RATINGS_TEMPLATE_EXAMPLE, RATINGS_TEMPLATE_HEADER } from './reviews'
import {
  eligibleDeliveredRange,
  improvementSuggestion,
  lastMonths,
  monthStartOf,
  parseRatingsFile,
  ratingDeltaOf,
  ratingGrowthOf,
  rateFromPercent,
  recentRatingPoints,
  solicitCoverageOf,
  solicitationWindowOf,
  topicMatchesReason,
} from './reviews-math'
import { EligibleQuerySchema, RatingsImportBodySchema, ReviewsQuerySchema, SolicitationBatchBodySchema } from './reviews-query'

const at = (text: string) => new Date(`${text}T00:00:00.000Z`)
const DAY = 86_400_000

describe('请求评价期限', () => {
  const now = at('2026-10-24')
  it('送达后第 5 至 30 天（含）是可请求期，按整天数算', () => {
    expect(solicitationWindowOf(new Date(now.getTime() - 4 * DAY), now).state).toBe('TOO_EARLY')
    expect(solicitationWindowOf(new Date(now.getTime() - 5 * DAY), now)).toEqual({ state: 'OPEN', daysSince: 5, daysLeft: 25 })
    expect(solicitationWindowOf(new Date(now.getTime() - 30 * DAY), now)).toEqual({ state: 'OPEN', daysSince: 30, daysLeft: 0 })
    expect(solicitationWindowOf(new Date(now.getTime() - 31 * DAY), now)).toEqual({ state: 'CLOSED', daysSince: 31, daysLeft: null })
  })
  it('可请求订单的送达时间范围与期限判断一致', () => {
    const { from, to } = eligibleDeliveredRange(now)
    expect(solicitationWindowOf(from, now).state).toBe('OPEN')
    expect(solicitationWindowOf(new Date(from.getTime() - 1), now).state).toBe('CLOSED')
    expect(solicitationWindowOf(to, now).state).toBe('OPEN')
    expect(solicitationWindowOf(new Date(to.getTime() + 1), now).state).toBe('TOO_EARLY')
  })
  it('覆盖率：没有已送达订单是 null，不是 0', () => {
    expect(solicitCoverageOf(0, 0)).toBeNull()
    expect(solicitCoverageOf(200, 50)).toBe(0.25)
    expect(solicitCoverageOf(10, 12)).toBe(1)
  })
})

describe('评分变化与增长', () => {
  const rows = [
    { date: '2026-08-01', avgRating: 4.2, ratingCount: 100 },
    { date: '2026-09-01', avgRating: 4.3, ratingCount: 130 },
    { date: '2026-10-01', avgRating: null, ratingCount: 190 },
  ]
  it('变化只在两次都有该字段时才给', () => {
    expect(ratingDeltaOf(rows)).toEqual({ ratingDelta: null, countDelta: 60, previousDate: '2026-09-01' })
    expect(ratingDeltaOf(rows.slice(0, 2))).toEqual({ ratingDelta: 0.1, countDelta: 30, previousDate: '2026-08-01' })
    expect(ratingDeltaOf(rows.slice(0, 1))).toEqual({ ratingDelta: null, countDelta: null, previousDate: null })
  })
  it('最近的采集点最多保留 N 个', () => {
    expect(recentRatingPoints(rows, 2).map(point => point.date)).toEqual(['2026-09-01', '2026-10-01'])
  })
  it('请求后评分数增长：请求前后各要有一次导入', () => {
    expect(ratingGrowthOf(rows, '2026-09-10')).toMatchObject({ beforeCount: 130, beforeDate: '2026-09-01', afterCount: 190, afterDate: '2026-10-01', delta: 60, note: null })
    expect(ratingGrowthOf(rows, '2026-10-05')).toMatchObject({ beforeCount: 190, afterCount: null, delta: null })
    expect(ratingGrowthOf(rows, '2026-10-05').note).toContain('再导入一次')
    expect(ratingGrowthOf(rows, '2026-07-01')).toMatchObject({ beforeCount: null, afterCount: 190, delta: null })
    expect(ratingGrowthOf([{ date: '2026-08-01', avgRating: 4, ratingCount: null }], '2026-08-02').note).toContain('没有导入过评分数')
  })
  it('请求当天导入的评分算“请求前”', () => {
    expect(ratingGrowthOf(rows, '2026-09-01').beforeDate).toBe('2026-09-01')
  })
})

describe('月份与比例', () => {
  it('取月初、取最近 N 个不同月份', () => {
    expect(monthStartOf(new Date('2026-10-24T08:00:00Z'))).toBe('2026-10-01')
    expect(monthStartOf('2026-03-15')).toBe('2026-03-01')
    expect(lastMonths(['2026-05-01', '2026-03-01', '2026-05-01', '2026-04-01', '2026-02-01'], 3)).toEqual(['2026-03-01', '2026-04-01', '2026-05-01'])
  })
  it('接口的百分数转成小数，超范围或非数字不夹取', () => {
    expect(rateFromPercent(12.5)).toBe(0.125)
    expect(rateFromPercent('7')).toBe(0.07)
    expect(rateFromPercent(100)).toBe(1)
    expect(rateFromPercent(101)).toBeNull()
    expect(rateFromPercent(-1)).toBeNull()
    expect(rateFromPercent('abc')).toBeNull()
    expect(rateFromPercent(null)).toBeNull()
  })
})

describe('主题与退货原因的文字重合', () => {
  it('只比对英文词，忽略过于通用的词', () => {
    expect(topicMatchesReason('Battery life', 'BATTERY_DIED')).toBe(true)
    expect(topicMatchesReason('Battery life', '电池不耐用')).toBe(false)
    expect(topicMatchesReason('Battery drains fast', 'battery drains')).toBe(true)
    expect(topicMatchesReason('Product quality', 'Product not as described')).toBe(false)
    expect(topicMatchesReason('Size runs small', 'Wrong size ordered')).toBe(true)
  })
  it('建议文字区分“可能相关”与“没有重合”', () => {
    expect(improvementSuggestion({ topic: 'Size runs small', reasonLabel: '尺码不合适', possiblyRelated: true })).toContain('有重合')
    expect(improvementSuggestion({ topic: 'Size runs small', reasonLabel: null, possiblyRelated: false })).toContain('没有重合')
    expect(improvementSuggestion({ topic: null, reasonLabel: null, possiblyRelated: false })).toContain('没有负面评论主题')
  })
})

describe('评分文件解析', () => {
  const header = '\uFEFFASIN,采集日期,平均星级,评分数,1星,2星,3星,4星,5星'
  it('正常文件：支持引号、千分位、斜杠日期、星级分布', () => {
    const text = [header, 'b0abcde123,2026-10-20,4.5,"1,280",10,20,30,40,50', 'B0ABCDE124,2026/9/5,,300,,,,,'].join('\r\n')
    const result = parseRatingsFile(text, '2026-10-24')
    expect(result.errors).toEqual([])
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({ line: 2, asin: 'B0ABCDE123', captureDate: '2026-10-20', avgRating: 4.5, ratingCount: 1280, distribution: { '1': 10, '2': 20, '3': 30, '4': 40, '5': 50 } })
    expect(result.rows[1]).toMatchObject({ asin: 'B0ABCDE124', captureDate: '2026-09-05', avgRating: null, ratingCount: 300, distribution: null })
  })
  it('支持制表符与英文列名', () => {
    const result = parseRatingsFile('asin\tcapture_date\tavg_rating\nB0ABCDE123\t2026-10-01\t4.1', '2026-10-24')
    expect(result.errors).toEqual([])
    expect(result.rows[0]).toMatchObject({ avgRating: 4.1, ratingCount: null })
  })
  it('缺列、空文件', () => {
    expect(parseRatingsFile('', '2026-10-24').errors[0].code).toBe('FILE_COLUMN_MISSING')
    expect(parseRatingsFile('ASIN,平均星级\nB0ABCDE123,4', '2026-10-24').errors.map(error => error.column)).toEqual(['采集日期'])
    expect(parseRatingsFile('ASIN,采集日期\nB0ABCDE123,2026-10-01', '2026-10-24').errors[0]).toMatchObject({ code: 'FILE_COLUMN_MISSING', column: '平均星级' })
  })
  it('一行有错整份拒绝：返回逐行原因，星级超范围、未来日期、重复行', () => {
    const text = [
      'ASIN,采集日期,平均星级,评分数',
      'B0ABCDE123,2026-10-01,5.5,10',
      'B0ABCDE124,2026-12-01,4,10',
      'B0ABCDE125,2026-10-01,4,-3',
      'B0ABCDE126,2026-10-01,4,10',
      'B0ABCDE126,2026-10-01,4,11',
      'SHORT,2026-10-01,4,1',
      'B0ABCDE127,2026-02-30,4,1',
      'B0ABCDE128,2026-10-01,,',
    ].join('\n')
    const { errors } = parseRatingsFile(text, '2026-10-24')
    expect(errors.map(error => [error.line, error.code])).toEqual([
      [2, 'FILE_VALUE_RANGE'],
      [3, 'FILE_VALUE_RANGE'],
      [4, 'FILE_VALUE_RANGE'],
      [6, 'FILE_DUPLICATE'],
      [7, 'FILE_VALUE_INVALID'],
      [8, 'FILE_VALUE_INVALID'],
      [9, 'FILE_VALUE_INVALID'],
    ])
  })
  it('超过行数上限整份拒绝', () => {
    const lines = ['ASIN,采集日期,平均星级']
    for (let index = 0; index <= REVIEWS_LIMITS.importRowsMax; index += 1) lines.push(`B0${String(index).padStart(8, '0')},2026-10-01,4`)
    expect(parseRatingsFile(lines.join('\n'), '2026-10-24').errors[0].message).toContain(String(REVIEWS_LIMITS.importRowsMax))
  })
  it('模板列与解析器认得的列一致', () => {
    const text = `${RATINGS_TEMPLATE_HEADER.join(',')}\n${RATINGS_TEMPLATE_EXAMPLE.join(',')}`
    const result = parseRatingsFile(text, '2026-12-31')
    expect(result.errors).toEqual([])
    expect(result.rows).toHaveLength(1)
  })
})

describe('请求校验', () => {
  it('常量清单', () => {
    expect(REVIEWS_TABS).toEqual(['ratings', 'topics', 'returns', 'solicit'])
    expect(REVIEW_SORTS).toContain('avgRating')
    expect(SOLICITATION_STATUSES).toContain('QUEUED')
  })
  it('列表查询：默认页签与排序，未知参数拒绝，星级上限要在 1 到 5', () => {
    expect(ReviewsQuerySchema.safeParse({ tab: 'topics', storeId: 's1', asin: 'B0ABCDE123' }).success).toBe(true)
    expect(ReviewsQuerySchema.safeParse({ tab: 'bad' }).success).toBe(false)
    expect(ReviewsQuerySchema.safeParse({ nothing: '1' }).success).toBe(false)
    expect(ReviewsQuerySchema.safeParse({ ratingBelow: '6' }).success).toBe(false)
    expect(EligibleQuerySchema.safeParse({ storeId: 's1', sort: 'deliveredAt:asc' }).success).toBe(true)
  })
  it('评分导入请求体：店铺、文件名、内容必填', () => {
    expect(RatingsImportBodySchema.safeParse({ storeId: 's1', fileName: 'a.csv', content: 'x' }).success).toBe(true)
    expect(RatingsImportBodySchema.safeParse({ storeId: 's1', fileName: 'a.csv', content: '' }).success).toBe(false)
    expect(RatingsImportBodySchema.safeParse({ storeId: 's1', fileName: '', content: 'x' }).success).toBe(false)
    expect(RatingsImportBodySchema.safeParse({ storeId: 's1', fileName: 'a.csv', content: 'x', extra: 1 }).success).toBe(false)
  })
  it('批量请求评价：1 到 50 个不重复订单', () => {
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `111-0000000-${String(index).padStart(7, '0')}`)
    expect(SolicitationBatchBodySchema.safeParse({ storeId: 's1', orderIds: ids(1) }).success).toBe(true)
    expect(SolicitationBatchBodySchema.safeParse({ storeId: 's1', orderIds: ids(REVIEWS_LIMITS.batchMax) }).success).toBe(true)
    expect(SolicitationBatchBodySchema.safeParse({ storeId: 's1', orderIds: ids(REVIEWS_LIMITS.batchMax + 1) }).success).toBe(false)
    expect(SolicitationBatchBodySchema.safeParse({ storeId: 's1', orderIds: [] }).success).toBe(false)
    expect(SolicitationBatchBodySchema.safeParse({ storeId: 's1', orderIds: [ids(1)[0], ids(1)[0]] }).success).toBe(false)
  })
})
