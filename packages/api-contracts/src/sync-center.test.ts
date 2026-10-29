import { describe, expect, it } from 'vitest'
import { ADS_PARITY_JOB, ADS_REPORT_V1_JOB } from './ads-reports'
import { ADS_ENTITY_SYNC_JOB } from './ads-sync'
import { ADS_WRITE_JOB } from './ads-write'
import { APLUS_SYNC_JOB, APLUS_WRITE_JOB } from './aplus'
import { CATALOG_SYNC_JOB } from './asin360'
import { AWD_LABELS_JOB, AWD_SYNC_JOB, AWD_WRITE_JOB } from './awd'
import { COMPETITOR_SYNC_JOB } from './competitors'
import { CONNECTION_HEALTH_JOB } from './connection-center'
import { INBOUND_OP_JOB, INBOUND_SYNC_JOB } from './inbound'
import { LISTING_SYNC_JOB } from './listing-quality'
import { LISTING_WRITE_JOB } from './listing-quality-write'
import { PRICING_SYNC_JOB } from './pricing'
import { PROMOTIONS_SYNC_JOB } from './promotions'
import { FEEDBACK_SYNC_JOB, SOLICITATION_SEND_JOB } from './reviews'
import { SALES_TAX_SYNC_JOB } from './sales-tax'
import { SETTLEMENT_SYNC_JOB } from './settlements'
import { SNS_JOB_TYPE } from './subscribe-save'
import { SUPPORT_SYNC_JOB } from './support'
import { SyncJobListQuerySchema } from './sync-center-query'
import {
  SYNC_DATA_DOMAINS,
  SYNC_DOMAIN_AVAILABILITY,
  SYNC_DOMAIN_LABEL,
  SYNC_JOB_TYPE_LABEL,
  SYNC_RESULT_MAX,
  SYNC_STATES,
  SYNC_STATE_LABEL,
  SYNC_TIMELINE_MAX,
  isWriteSyncType,
  syncDataDomainOf,
  syncFailureText,
  syncReportDomainOf,
  syncRetryBlockReason,
  syncStateOf,
} from './sync-center'
import { appendSyncEvent, syncEventText, syncEventsOf, syncResultItemsOf, syncResultStatsOf } from './sync-center-trace'
import { SYNC_QUEUE_LABEL, bucketTokensAt } from './sync-center-views'

const DOMAIN_COUNT = 19

describe('同步中心：数据域', () => {
  it('09 章 9.8 列出的 18 个数据域都在，外加“连接与系统任务”，每个都有名称与可用性说明', () => {
    expect(SYNC_DATA_DOMAINS).toHaveLength(DOMAIN_COUNT)
    expect(Object.keys(SYNC_DOMAIN_LABEL).sort()).toEqual([...SYNC_DATA_DOMAINS].sort())
    expect(Object.keys(SYNC_DOMAIN_AVAILABILITY).sort()).toEqual([...SYNC_DATA_DOMAINS].sort())
    for (const label of [
      '订单',
      '库存',
      '财务交易',
      '商品与刊登',
      '定价',
      '入仓',
      '上游仓储',
      '业务报告与数据中心',
      '品牌分析',
      '客户反馈',
      '促销',
      '订阅省',
      'A+ 内容',
      '支持案件',
      '账户健康',
      '广告实体',
      '广告报表',
      '营销数据流',
    ]) {
      expect(Object.values(SYNC_DOMAIN_LABEL)).toContain(label)
    }
  })

  it('没有交付的同步器写“尚未接入”：营销数据流没有同步任务；部分交付的数据域写明缺什么', () => {
    expect(SYNC_DOMAIN_AVAILABILITY.ADS_STREAM.availability).toBe('NOT_CONNECTED')
    expect(SYNC_DOMAIN_AVAILABILITY.ADS_ENTITIES.availability).toBe('LIVE')
    expect(SYNC_DOMAIN_AVAILABILITY.ADS_REPORTS.availability).toBe('LIVE')
    expect(syncDataDomainOf(ADS_ENTITY_SYNC_JOB)).toBe('ADS_ENTITIES')
    for (const domain of SYNC_DATA_DOMAINS) {
      if (SYNC_DOMAIN_AVAILABILITY[domain].availability !== 'LIVE') expect(SYNC_DOMAIN_AVAILABILITY[domain].note, domain).toBeTruthy()
    }
  })

  it('代码里已有的任务类型都有名称，也都归到某个数据域（连接健康检查除外归系统任务）', () => {
    const types = [
      'FBA_ORDERS',
      'FBA_INVENTORY',
      'FBA_FINANCE',
      'FBA_INBOUND_CREATE',
      'FBA_ADS',
      'FBA_REPORT_CREATE',
      'FBA_REPORT_POLL',
      'ADS_REPORT_CREATE',
      'ADS_REPORT_POLL',
      'DATA_KIOSK_QUERY',
      INBOUND_SYNC_JOB,
      INBOUND_OP_JOB,
      SNS_JOB_TYPE,
      AWD_SYNC_JOB,
      AWD_WRITE_JOB,
      AWD_LABELS_JOB,
      CATALOG_SYNC_JOB,
      LISTING_SYNC_JOB,
      LISTING_WRITE_JOB,
      PRICING_SYNC_JOB,
      'PRICING_FEE_ESTIMATE',
      COMPETITOR_SYNC_JOB,
      FEEDBACK_SYNC_JOB,
      SOLICITATION_SEND_JOB,
      PROMOTIONS_SYNC_JOB,
      APLUS_SYNC_JOB,
      APLUS_WRITE_JOB,
      SUPPORT_SYNC_JOB,
      SETTLEMENT_SYNC_JOB,
      SALES_TAX_SYNC_JOB,
      ADS_REPORT_V1_JOB,
      ADS_ENTITY_SYNC_JOB,
      ADS_PARITY_JOB,
      ADS_WRITE_JOB,
      CONNECTION_HEALTH_JOB,
    ]
    for (const type of types) {
      expect(SYNC_JOB_TYPE_LABEL[type], type).toBeTruthy()
      if (type === CONNECTION_HEALTH_JOB) expect(syncDataDomainOf(type)).toBe('SYSTEM')
      else expect(syncDataDomainOf(type), type).not.toBe('SYSTEM')
    }
    expect(syncDataDomainOf('SOMETHING_NEW')).toBe('SYSTEM')
  })

  it('报告任务按报告类型归域：品牌分析、账户健康、财务各归各的，其余归业务报告', () => {
    expect(syncReportDomainOf('GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT')).toBe('BRAND')
    expect(syncReportDomainOf('GET_V2_SELLER_PERFORMANCE_REPORT')).toBe('ACCOUNT_HEALTH')
    expect(syncReportDomainOf('GET_FBA_REIMBURSEMENTS_DATA')).toBe('FINANCE')
    expect(syncReportDomainOf('GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA')).toBe('REPORTS')
    expect(syncReportDomainOf(undefined)).toBe('REPORTS')
    expect(syncDataDomainOf('FBA_REPORT_CREATE', { reportType: 'GET_V2_SELLER_PERFORMANCE_REPORT' })).toBe('ACCOUNT_HEALTH')
    expect(syncDataDomainOf('FBA_REPORT_POLL', null)).toBe('REPORTS')
  })

  it('写入类任务标出来（重试会重新提交写入）', () => {
    for (const type of [ADS_WRITE_JOB, LISTING_WRITE_JOB, APLUS_WRITE_JOB, AWD_WRITE_JOB, SOLICITATION_SEND_JOB, INBOUND_OP_JOB, 'FBA_INBOUND_CREATE']) expect(isWriteSyncType(type), type).toBe(true)
    for (const type of ['FBA_ORDERS', AWD_LABELS_JOB, CONNECTION_HEALTH_JOB]) expect(isWriteSyncType(type), type).toBe(false)
  })
})

describe('同步中心：状态与重试', () => {
  it('PENDING 按尝试次数与失败码区分排队、等待重试、等待报告；失败码与永久失败都算失败', () => {
    expect(syncStateOf({ status: 'PENDING', attempts: 0, failureCode: null })).toBe('QUEUED')
    expect(syncStateOf({ status: 'PENDING', attempts: 2, failureCode: 'UPSTREAM_ERROR' })).toBe('RETRY_WAIT')
    expect(syncStateOf({ status: 'PENDING', attempts: 1, failureCode: null })).toBe('POLL_WAIT')
    expect(syncStateOf({ status: 'RUNNING', attempts: 1, failureCode: null })).toBe('RUNNING')
    expect(syncStateOf({ status: 'SUCCEEDED', attempts: 1, failureCode: null })).toBe('SUCCEEDED')
    expect(syncStateOf({ status: 'FAILED_PERMANENT', attempts: 5, failureCode: 'X' })).toBe('FAILED')
    expect(syncStateOf({ status: 'FAILED', attempts: 0, failureCode: 'QUEUE_UNAVAILABLE' })).toBe('FAILED')
    expect(Object.keys(SYNC_STATE_LABEL).sort()).toEqual([...SYNC_STATES].sort())
  })

  it('只有失败的任务可以重试；已作废的任务说明原因', () => {
    expect(syncRetryBlockReason({ status: 'FAILED_PERMANENT', failureCode: 'AUTH_EXPIRED' })).toBeNull()
    expect(syncRetryBlockReason({ status: 'FAILED', failureCode: null })).toBeNull()
    expect(syncRetryBlockReason({ status: 'SUCCEEDED', failureCode: null })).toMatch(/只有失败的任务/)
    expect(syncRetryBlockReason({ status: 'RUNNING', failureCode: null })).toMatch(/只有失败的任务/)
    expect(syncRetryBlockReason({ status: 'PENDING', failureCode: 'X' })).toMatch(/只有失败的任务/)
    expect(syncRetryBlockReason({ status: 'FAILED_PERMANENT', failureCode: 'CONNECTION_DISCONNECTED' })).toMatch(/连接中心/)
    expect(syncRetryBlockReason({ status: 'FAILED_PERMANENT', failureCode: 'REPORT_CANCELLED' })).toMatch(/报表中心/)
    expect(syncRetryBlockReason({ status: 'FAILED_PERMANENT', failureCode: 'JOB_TENANT_MISMATCH' })).toMatch(/归属/)
  })

  it('失败原因：登记过的写中文说明，没登记的保留失败码', () => {
    expect(syncFailureText(null)).toBeNull()
    expect(syncFailureText('AUTH_EXPIRED')).toMatch(/重新授权/)
    expect(syncFailureText('WORKER_CRASHED')).toMatch(/进程中断/)
    expect(syncFailureText('SOMETHING_ODD')).toBe('同步失败（SOMETHING_ODD）')
  })
})

describe('同步中心：时间线与统计', () => {
  const t0 = new Date('2026-10-25T00:00:00.000Z')

  it('追加事件：相同阶段与文字不重复，超过上限丢最早的，坏数据丢弃', () => {
    const one = appendSyncEvent(null, 'STARTED', '第 1 次尝试', t0)
    expect(one).toEqual([{ at: t0.toISOString(), stage: 'STARTED', text: '第 1 次尝试' }])
    expect(appendSyncEvent(one, 'STARTED', '第 1 次尝试', new Date(t0.getTime() + 1000))).toHaveLength(1)
    expect(appendSyncEvent(one, 'STARTED', '第 2 次尝试', t0)).toHaveLength(2)
    let events: unknown = null
    for (let index = 0; index < SYNC_TIMELINE_MAX + 5; index += 1) events = appendSyncEvent(events, 'STARTED', `第 ${index} 次尝试`, t0)
    expect(syncEventsOf(events)).toHaveLength(SYNC_TIMELINE_MAX)
    expect(syncEventsOf(events)[0].text).toBe('第 5 次尝试')
    expect(syncEventsOf([{ at: 1, stage: 'STARTED' }, { at: 'x', stage: 'NOPE' }, null, { at: 'y', stage: 'FAILED', text: '' }])).toEqual([{ at: 'y', stage: 'FAILED' }])
    expect(syncEventsOf('not an array')).toEqual([])
    expect(appendSyncEvent(null, 'FAILED', 'x'.repeat(400), t0)[0].text).toHaveLength(300)
  })

  it('事件文字：失败与等待重试里存的失败码翻成中文（保留“第 n/5 次”后缀），其余原样，没有文字返回 null', () => {
    expect(syncEventText('FAILED', 'AUTH_EXPIRED')).toBe(syncFailureText('AUTH_EXPIRED'))
    expect(syncEventText('RETRY_WAIT', 'THROTTLED（第 2/5 次尝试失败）')).toBe(`${syncFailureText('THROTTLED')}（第 2/5 次尝试失败）`)
    expect(syncEventText('FAILED', 'WORKER_CRASHED')).toBe(syncFailureText('WORKER_CRASHED'))
    expect(syncEventText('STARTED', '第 1 次尝试')).toBe('第 1 次尝试')
    expect(syncEventText('FAILED', '已经是中文说明')).toBe('已经是中文说明')
    expect(syncEventText('FAILED', undefined)).toBeNull()
  })

  it('写入统计只留顶层的数字；没有数字返回 null；最多 20 项', () => {
    expect(syncResultStatsOf({ imported: 120, markets: ['US'], parity: { ran: true }, note: '文字', skipped: 2, bad: Number.NaN })).toEqual({ imported: 120, skipped: 2 })
    expect(syncResultStatsOf({ ready: true, reportId: 'abc' })).toBeNull()
    expect(syncResultStatsOf(null)).toBeNull()
    expect(syncResultStatsOf([1, 2])).toBeNull()
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, index]))
    expect(Object.keys(syncResultStatsOf(many) ?? {})).toHaveLength(SYNC_RESULT_MAX)
    expect(syncResultItemsOf({ imported: 5, odd_key: 3, text: 'x' })).toEqual([
      { key: 'imported', label: '导入行数', value: 5 },
      { key: 'odd_key', label: 'odd_key', value: 3 },
    ])
    expect(syncResultItemsOf(null)).toEqual([])
  })
})

describe('同步中心：队列与令牌桶', () => {
  it('队列名称覆盖全部同步队列与辅助队列', () => {
    for (const queue of [
      'sync-orders',
      'sync-inventory',
      'sync-finance',
      'sync-ads',
      'sync-inbound',
      'sync-awd',
      'sync-reports',
      'sync-general',
      'sync',
      'reports',
      'exports',
      'notifications',
      'lifecycle',
    ]) {
      expect(SYNC_QUEUE_LABEL[queue], queue).toBeTruthy()
    }
  })

  it('令牌桶余量按补充速率折算到现在，不超过突发上限，时间倒流不扣减', () => {
    const bucket = { tokens: 0, updatedAt: 1_000, rate: 2, burst: 4 }
    expect(bucketTokensAt(bucket, 2_000)).toBe(2)
    expect(bucketTokensAt(bucket, 10_000)).toBe(4)
    expect(bucketTokensAt({ ...bucket, tokens: 3 }, 500)).toBe(3)
  })
})

describe('同步中心：请求校验', () => {
  it('数据域与状态筛选只认已登记的取值；未知参数一律拒绝', () => {
    expect(SyncJobListQuerySchema.safeParse({ domain: 'ORDERS', state: 'FAILED' }).success).toBe(true)
    expect(SyncJobListQuerySchema.safeParse({ domain: 'NOPE' }).success).toBe(false)
    expect(SyncJobListQuerySchema.safeParse({ state: 'PENDING' }).success).toBe(false)
    expect(SyncJobListQuerySchema.safeParse({ unknown: '1' }).success).toBe(false)
    const parsed = SyncJobListQuerySchema.parse({})
    expect(parsed.sort).toEqual({ field: 'createdAt', dir: 'desc' })
  })
})
