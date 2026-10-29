import {
  CASE_STATUSES,
  REIMBURSEMENT_WINDOW_DEFAULTS,
  ruleStats,
  type CaseDetailResponse,
  type CaseListResponse,
  type CaseRow,
  type OpportunityListResponse,
  type OpportunityRow,
  type ReimbursementStatsResponse,
  type CaseStatus,
} from '@nova/api-contracts'
import { OPPORTUNITY_RULES } from '@nova/api-contracts'

// 赔付中心页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const freshness = { lastSuccessAt: '2026-10-23T08:00:00.000Z', sources: ['rpt.reimbursements'], qualityIssues: 0 }
const pageInfo = (count: number) => ({ pageSize: 20, nextCursor: null, hasMore: false, approxTotal: count })

export const oppRow = (over: Partial<OpportunityRow> = {}): OpportunityRow => ({
  id: 'o1',
  ruleCode: 'LEDGER_LOST',
  ruleLabel: '仓内丢失',
  connected: true,
  sellerAccountId: 's1',
  storeName: '美国主店',
  sku: 'SKU-1',
  qty: 3,
  status: 'PENDING',
  statusLabel: '待处理',
  estimatedAmount: 15,
  currency: 'USD',
  deadlineAt: '2027-01-10',
  detectedAt: '2026-10-20T00:00:00.000Z',
  evidence: [{ kind: 'LEDGER', id: 'l1', label: '库存台账 2026-08-01 丢失 3 件' }],
  caseId: null,
  caseNo: null,
  note: null,
  version: 1,
  ...over,
})

export const oppList = (items: OpportunityRow[] = [oppRow()], over: Partial<OpportunityListResponse> = {}): OpportunityListResponse => ({
  state: items.length ? 'OK' : 'NO_DATA',
  note: null,
  items,
  pageInfo: pageInfo(items.length),
  freshness,
  ...over,
})

export const caseRow = (over: Partial<CaseRow> = {}): CaseRow => ({
  id: 'c1',
  caseNo: 'PC-20261023-ABCDE',
  ruleCode: 'LEDGER_LOST',
  ruleLabel: '仓内丢失',
  status: 'OPPORTUNITY',
  statusLabel: '待提交',
  sellerAccountId: 's1',
  storeName: '美国主店',
  sku: 'SKU-1',
  qty: 3,
  expectedAmount: 15,
  approvedAmount: null,
  receivedAmount: 0,
  currency: 'USD',
  ownerId: 'u1',
  ownerName: '张三',
  amazonCaseId: null,
  submittedAt: null,
  decidedAt: null,
  paidAt: null,
  deadlineAt: '2027-01-10T00:00:00.000Z',
  opportunityId: 'o1',
  note: null,
  version: 3,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  ...over,
})

export const caseList = (items: CaseRow[] = [caseRow()], over: Partial<CaseListResponse> = {}): CaseListResponse => ({
  state: items.length ? 'OK' : 'NO_DATA',
  note: null,
  items,
  pageInfo: pageInfo(items.length),
  freshness,
  ...over,
})

export const stats = (over: Partial<ReimbursementStatsResponse> = {}): ReimbursementStatsResponse => ({
  state: 'OK',
  note: null,
  caseCounts: Object.fromEntries(CASE_STATUSES.map((status: CaseStatus) => [status, 0])) as Record<CaseStatus, number>,
  pendingOpportunities: 4,
  recovery: [],
  avgPayDays: null,
  paidSample: 0,
  rules: ruleStats([], { LEDGER_LOST: 4 }, rule => rule !== 'FEE_OVERCHARGE', Object.fromEntries(OPPORTUNITY_RULES.map(rule => [rule, `${rule} 的识别依据`])) as never),
  unmatched: { count: 0, byCurrency: [] },
  windows: { ...REIMBURSEMENT_WINDOW_DEFAULTS },
  windowsDefault: true,
  windowsVersion: 0,
  basis: '回收率 = 实收 ÷ 应收（测试说明）',
  freshness,
  ...over,
})

export const detail = (over: Partial<CaseDetailResponse> = {}): CaseDetailResponse => ({
  case: caseRow(),
  basis: '库存台账出现“丢失”调整，过了等待期仍没有“找到”调整。',
  evidence: [{ kind: 'LEDGER', id: 'l1', label: '库存台账 2026-08-01 丢失 3 件' }],
  attachments: [],
  records: [],
  packs: [],
  nextStatuses: ['SUBMITTED'],
  canWrite: true,
  supportCases: { state: 'NO_ID', note: '这个赔付案件还没有回填亚马逊案件编号' },
  freshness,
  ...over,
})
