import {
  ACCOUNT_HEALTH_ROLE_GUIDE,
  type AccountHealthResponse,
  type AccountHealthStoreView,
  type HealthMetricView,
  type PolicyIssueDetail,
  type PolicyIssueListResponse,
  type PolicyIssueRow,
} from '@nova/api-contracts'

// 账户健康页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

const sync = { status: 'NORMAL', statusLabel: '正常', lastSuccessAt: '2026-10-24T01:00:00.000Z', errorCode: null, errorMessage: null, rolePending: false } as const

export const metric = (over: Partial<HealthMetricView> = {}): HealthMetricView => ({
  key: 'orderDefectRate.afn',
  label: '订单缺陷率（亚马逊配送）',
  group: 'ORDER_DEFECT',
  value: 0.012,
  target: 0.01,
  targetCondition: 'LT',
  targetText: '低于 1%',
  status: 'NOT_MET',
  statusLabel: '未达标',
  unit: 'RATIO',
  windowDays: 60,
  ...over,
})

export const storeView = (over: Partial<AccountHealthStoreView> = {}): AccountHealthStoreView => ({
  sellerAccountId: 's1',
  storeName: '美国主店',
  state: 'OK',
  note: null,
  sync: { ...sync },
  snapshotDate: '2026-10-24',
  accountStatus: { status: 'AT_RISK', label: '有风险', asOf: '2026-10-24', source: 'REPORT', previousStatus: 'NORMAL', previousLabel: '正常', changedAt: '2026-10-23' },
  rating: { score: 312, status: 'GOOD', statusLabel: '良好' },
  ratingTrend: [
    { date: '2026-10-23', value: 280 },
    { date: '2026-10-24', value: 312 },
  ],
  statusHistory: [
    { date: '2026-10-22', status: 'NORMAL', label: '正常', previousStatus: null, previousLabel: null, worse: false },
    { date: '2026-10-23', status: 'AT_RISK', label: '有风险', previousStatus: 'NORMAL', previousLabel: '正常', worse: true },
  ],
  orderDefect: {
    metrics: [metric()],
    breakdown: [
      {
        key: 'NEGATIVE_FEEDBACK',
        label: '负面反馈率',
        metric: metric({ key: 'negativeFeedbackRate', label: '负面反馈率', value: 0.004, target: null, targetCondition: null, targetText: null, status: 'UNKNOWN', statusLabel: '未判定' }),
        note: null,
      },
      { key: 'CLAIMS', label: '交易保障索赔率', metric: null, note: '报告未分项给出' },
      { key: 'CHARGEBACK', label: '拒付率', metric: null, note: '报告未分项给出' },
    ],
    trend: [
      {
        key: 'orderDefectRate.afn',
        label: '订单缺陷率（亚马逊配送）',
        unit: 'RATIO',
        points: [
          { date: '2026-10-23', value: 0.004 },
          { date: '2026-10-24', value: 0.012 },
        ],
      },
    ],
  },
  policy: {
    metrics: [
      metric({
        key: 'listingPolicyViolations',
        label: 'listingPolicyViolations',
        group: 'POLICY',
        value: 3,
        target: null,
        targetCondition: null,
        targetText: null,
        status: 'UNKNOWN',
        statusLabel: '未判定',
        unit: 'COUNT',
        windowDays: null,
      }),
    ],
    openByKind: [{ kind: 'LISTING_POLICY', label: '上架政策违规', count: 2 }],
    openCount: 2,
  },
  other: [metric({ key: 'lateShipmentRate', label: '迟发率', group: 'OTHER', value: 0.03, target: null, targetCondition: null, targetText: null, status: 'UNKNOWN', statusLabel: '未判定' })],
  ...over,
})

export const emptyStore = (over: Partial<AccountHealthStoreView> = {}): AccountHealthStoreView =>
  storeView({
    sellerAccountId: 's2',
    storeName: '欧洲店',
    state: 'NOT_CONNECTED',
    note: '这个店铺还没有接入亚马逊授权，没有账户健康数据；接入后每日同步一次',
    snapshotDate: null,
    accountStatus: { status: null, label: null, asOf: null, source: null, previousStatus: null, previousLabel: null, changedAt: null },
    rating: null,
    ratingTrend: [],
    statusHistory: [],
    orderDefect: { metrics: [], breakdown: [], trend: [] },
    policy: { metrics: [], openByKind: [], openCount: 0 },
    other: [],
    ...over,
  })

export const overview = (stores: AccountHealthStoreView[] = [storeView(), emptyStore()], over: Partial<AccountHealthResponse> = {}): AccountHealthResponse => ({
  stores,
  push: { state: 'NOT_CONNECTED', note: '账户状态变更推送尚未接入（推送接收端是后续工作）：账户状态目前只来自每日一次的账户健康报告，状态变化最长会晚一天出现。' },
  truncated: false,
  freshness: { lastSuccessAt: '2026-10-24T01:00:00.000Z', sources: ['卖家表现报告（账户健康）'], qualityIssues: 0 },
  basis: '来自亚马逊卖家表现报告（每日同步一次）',
  ...over,
})

export const issueRow = (over: Partial<PolicyIssueRow> = {}): PolicyIssueRow => ({
  id: 'i1',
  issueId: 'VIO-2026-100',
  sellerAccountId: 's1',
  storeName: '美国主店',
  kind: 'LISTING_POLICY',
  kindLabel: '上架政策违规',
  title: 'Restricted products',
  asins: ['B000000001'],
  status: 'OPEN',
  statusLabel: '未解决',
  firstSeenAt: '2026-10-20T00:00:00.000Z',
  lastSeenAt: '2026-10-24T00:00:00.000Z',
  resolvedAt: null,
  impactText: '搜索结果被隐藏',
  handlingStatus: 'OPEN',
  handlingStatusLabel: '待处理',
  owner: null,
  amazonCaseId: null,
  version: 1,
  ...over,
})

export const issueList = (items: PolicyIssueRow[] = [issueRow()], over: Partial<PolicyIssueListResponse> = {}): PolicyIssueListResponse => ({
  state: items.length > 0 ? 'OK' : 'NO_DATA',
  note: items.length > 0 ? null : '目前没有政策合规问题记录（来自每日同步的账户健康报告；报告里没有问题条目就不会有记录）',
  items,
  pageInfo: { hasMore: false, nextCursor: null, pageSize: 20, approxTotal: items.length },
  counts: { OPEN: items.length, RESOLVED: 1 },
  truncated: false,
  sync: { ...sync },
  freshness: { lastSuccessAt: '2026-10-24T01:00:00.000Z', sources: [], qualityIssues: 0 },
  ...over,
})

export const issueDetail = (over: Partial<PolicyIssueDetail> = {}): PolicyIssueDetail => ({
  issue: { ...issueRow(), handlingNote: null },
  timeline: [],
  support: { state: 'NONE', note: '没有关联的支持案件；在卖家后台提交申诉后，把案件编号填到这个问题上即可关联', cases: [] },
  owners: [
    { id: 'u2', name: '乙' },
    { id: 'u3', name: '丙' },
  ],
  ...over,
})

export const roleGuide = ACCOUNT_HEALTH_ROLE_GUIDE
