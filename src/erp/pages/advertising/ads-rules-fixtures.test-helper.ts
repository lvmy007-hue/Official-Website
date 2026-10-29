import {
  ADS_RULE_DRY_RUN_CAVEATS,
  ADS_RULE_EXECUTION_PENDING,
  describeRuleSpec,
  type AdsRuleDetailResponse,
  type AdsRuleDryRunResponse,
  type AdsRuleHit,
  type AdsRuleListResponse,
  type AdsRuleQuality,
  type AdsRuleRow,
  type AdsRuleRunRow,
  type AdsRuleRunsResponse,
  type AdsRuleSpec,
} from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok } from './ads-fixtures.test-helper'

// 自动规则页测试用的假服务端数据（只在测试里使用）。

export const campaignSpec = (patch: Partial<AdsRuleSpec> = {}): AdsRuleSpec => ({
  level: 'CAMPAIGN',
  conditions: [{ metric: 'acos', windowDays: 7, op: 'gt', value: 40 }],
  textFilters: [],
  campaignIds: [],
  action: { type: 'PAUSE' },
  guardrails: { minValue: null, maxValue: null, maxChangePercent: null, dailyLimit: 20 },
  ...patch,
})

export const ruleRow = (patch: Partial<AdsRuleRow> = {}): AdsRuleRow => {
  const spec = patch.spec ?? campaignSpec()
  return {
    id: 'r-1',
    adsProfileId: 'ap-a',
    accountName: '美国账户',
    storeName: 'Northstar US',
    name: '高 ACoS 活动暂停',
    mode: 'SUGGEST',
    status: 'ACTIVE',
    frequency: 'DAILY',
    spec,
    summary: describeRuleSpec(spec),
    lastRunAt: '2026-10-23T08:00:00.000Z',
    lastEvaluated: 12,
    lastMatched: 3,
    version: 2,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-22T08:00:00.000Z',
    updatedByName: '林然',
    ...patch,
  }
}

export const listResponse = (patch: Partial<AdsRuleListResponse> = {}): AdsRuleListResponse => ({
  rules: {
    state: 'OK',
    note: null,
    items: [
      ruleRow(),
      ruleRow({
        id: 'r-2',
        name: '搜索词否定',
        status: 'PAUSED',
        lastRunAt: null,
        lastEvaluated: null,
        lastMatched: null,
        spec: campaignSpec({ level: 'SEARCH_TERM', action: { type: 'NEGATE', matchType: 'NEGATIVE_EXACT' } }),
      }),
    ],
    truncated: false,
  },
  profiles: [{ id: 'ap-a', name: '美国账户', storeName: 'Northstar US' }],
  canWrite: true,
  auto: { allowed: false, reason: '写入开关“自动规则执行”未开启' },
  execution: ADS_RULE_EXECUTION_PENDING,
  ...patch,
})

export const qualityOf = (patch: Partial<AdsRuleQuality> = {}): AdsRuleQuality => ({
  windowDays: 30,
  lastScan: { at: '2026-10-23T08:00:00.000Z', evaluated: 12, matched: 3, hitRate: 0.25 },
  recent: { runs: 6, suggested: 4, applied: 0, skipped: 2, failed: 0, objects: 5 },
  adoption: { state: 'OK', open: 1, handled: 2, notNeeded: 1, falsePositive: 0, adoptionRate: 2 / 3 },
  effect: { state: 'NOT_CONNECTED', note: '还没有已执行的动作，自动执行随广告写入接入提供', samples: 0, windowDays: 7, before: null, after: null },
  notes: [],
  ...patch,
})

export const detailResponse = (patch: Partial<AdsRuleDetailResponse> = {}): AdsRuleDetailResponse => ({
  rule: ruleRow(),
  quality: qualityOf(),
  canWrite: true,
  auto: { allowed: false, reason: '写入开关“自动规则执行”未开启' },
  execution: ADS_RULE_EXECUTION_PENDING,
  ...patch,
})

export const hitRow = (patch: Partial<AdsRuleHit> = {}): AdsRuleHit => ({
  key: 'c-1',
  label: '春季推广',
  campaignLabel: null,
  metrics: { 'acos:7': 55.5 },
  actionType: 'PAUSE',
  before: '启用中',
  after: '已暂停',
  notes: [],
  spend: 120,
  ...patch,
})

export const dryRunResponse = (patch: Partial<AdsRuleDryRunResponse> = {}): AdsRuleDryRunResponse => ({
  state: 'OK',
  note: null,
  asOf: '2026-10-22',
  dataThrough: '2026-10-22',
  evaluated: 12,
  matched: 2,
  dailyLimit: 20,
  hits: [hitRow(), hitRow({ key: 'c-2', label: '夏季推广', metrics: { 'acos:7': 61 }, spend: null })],
  skipped: [{ key: 'c-3', label: '秋季推广', reason: '已经是暂停状态' }],
  truncated: false,
  incomplete: false,
  caveats: ADS_RULE_DRY_RUN_CAVEATS,
  ...patch,
})

export const runRow = (patch: Partial<AdsRuleRunRow> = {}): AdsRuleRunRow => ({
  id: 'run-1',
  entityKey: 'c-1',
  entityLabel: '春季推广',
  actionType: 'PAUSE',
  before: '启用中',
  after: '已暂停',
  outcome: 'SUGGESTED',
  executed: false,
  message: '建议模式：已生成待办',
  workItemId: 'w-1',
  evidence: { 'acos:7': 55.5 },
  runAt: '2026-10-23T08:00:00.000Z',
  ...patch,
})

export const runsResponse = (patch: Partial<AdsRuleRunsResponse> = {}): AdsRuleRunsResponse => ({
  state: 'OK',
  note: null,
  items: [runRow(), runRow({ id: 'run-2', entityKey: 'c-2', entityLabel: null, outcome: 'SKIPPED', workItemId: null, before: null, after: null, message: '已有未处理的待办' })],
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 2 },
  ...patch,
})

export const campaignRows = () => ({
  items: [
    { id: 'cam-1', adsProfileId: 'ap-a', name: '春季推广' },
    { id: 'cam-x', adsProfileId: 'ap-other', name: '别的账户的活动' },
  ],
})

export const listHandlers = (response: () => AdsRuleListResponse = () => listResponse(), extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/ads/rules': () => ok(response()),
  '/ads/campaigns': () => ok(campaignRows()),
  ...extra,
})

export const detailHandlers = (detail: () => AdsRuleDetailResponse = () => detailResponse(), extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/ads/rules/r-1': () => ok(detail()),
  '/ads/rules/r-1/runs': () => ok(runsResponse()),
  '/ads/campaigns': () => ok(campaignRows()),
  ...extra,
})
