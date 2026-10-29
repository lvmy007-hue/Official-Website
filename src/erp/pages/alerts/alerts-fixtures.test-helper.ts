import type { AlertDetailResponse, AlertListItem, AlertListResponse, AlertRuleView, AlertRulesResponse } from '@nova/api-contracts'

// 预警页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const alertRow = (over: Partial<AlertListItem> = {}): AlertListItem => ({
  id: 'a1',
  ruleId: 'r1',
  ruleCode: 'ADS_HIGH_SPEND_LOW_RETURN',
  ruleName: '高花费低产出',
  domain: 'ADS',
  domainLabel: '广告',
  severity: 'WARNING',
  status: 'NEW',
  statusLabel: '新预警',
  title: '广告活动“春季促销”花费高、产出低',
  entity: { type: 'CAMPAIGN', id: 'c1', label: '春季促销', path: '/app/advertising/campaigns/c1' },
  storeName: '美国主店',
  impact: { min: 30, max: 60, currency: 'USD' },
  suggestedAction: '降低竞价或暂停该活动',
  owner: { id: 'user-1', name: '甲' },
  triggerCount: 2,
  ruleVersionNo: 2,
  firstTriggeredAt: '2026-10-20T00:00:00.000Z',
  lastTriggeredAt: '2026-10-21T00:00:00.000Z',
  resolvedAt: null,
  read: false,
  ...over,
})

/** 按行编号取表格行的文字（表格是虚拟化的 AG Grid，固定列与滚动区是分开的几个元素）。 */
export const rowText = (id: string) =>
  Array.from(document.querySelectorAll(`[row-id="${id}"]`))
    .map(el => el.textContent ?? '')
    .join(' ')

export const alertList = (items: AlertListItem[] = [alertRow()], over: Partial<AlertListResponse> = {}): AlertListResponse => ({
  state: items.length > 0 ? 'OK' : 'NO_DATA',
  note: items.length > 0 ? null : '尚无预警：系统每 15 分钟按预警规则评估一次',
  items,
  pageInfo: { hasMore: false, nextCursor: null, pageSize: 20, approxTotal: items.length },
  counts: { open: items.length, handled: 3, ignored: 1, recovered: 2, all: items.length + 6 },
  domainOpenCounts: { INVENTORY: 0, PRODUCT: 0, AFTER_SALES: 0, FINANCE: 0, ADS: items.length, SYSTEM: 0 },
  unreadCount: items.filter(item => !item.read).length,
  ...over,
})

export const alertDetail = (over: Partial<AlertDetailResponse> = {}): AlertDetailResponse => ({
  alert: alertRow(),
  rule: {
    id: 'r1',
    code: 'ADS_HIGH_SPEND_LOW_RETURN',
    name: '高花费低产出',
    description: '近期花费高、广告成本销售比过高的广告活动',
    severity: 'WARNING',
    cooldownMinutes: 1440,
    enabled: true,
    versionNo: 2,
    currentVersion: 2,
    thresholds: [
      { label: '回看天数', value: '7 天' },
      { label: '花费下限', value: '20 美元' },
    ],
  },
  evidence: [
    { label: '花费', value: 'USD 45.50' },
    { label: '点击', value: '80' },
  ],
  history: [
    {
      id: 'a0',
      current: false,
      status: 'HANDLED',
      statusLabel: '已处理',
      severity: 'WARNING',
      triggerCount: 3,
      firstTriggeredAt: '2026-10-01T00:00:00.000Z',
      lastTriggeredAt: '2026-10-03T00:00:00.000Z',
      resolvedAt: '2026-10-04T00:00:00.000Z',
      conclusionLabel: '已处理',
    },
    {
      id: 'a1',
      current: true,
      status: 'NEW',
      statusLabel: '新预警',
      severity: 'WARNING',
      triggerCount: 2,
      firstTriggeredAt: '2026-10-20T00:00:00.000Z',
      lastTriggeredAt: '2026-10-21T00:00:00.000Z',
      resolvedAt: null,
      conclusionLabel: null,
    },
  ],
  ruleTrend: Array.from({ length: 30 }, (_, index) => ({ date: `2026-10-${String((index % 28) + 1).padStart(2, '0')}`, count: index % 3 })),
  timeline: [{ id: 't1', at: '2026-10-20T00:00:00.000Z', title: '规则“高花费低产出”首次触发（规则版本 v2）', actor: '系统' }],
  workItem: { id: 'w1', status: 'PENDING', dueAt: '2026-10-22T00:00:00.000Z', path: '/app/my/work-items?item=w1' },
  closeInfo: null,
  can: { handle: true },
  assignees: [
    { id: 'user-1', name: '甲' },
    { id: 'user-2', name: '乙' },
  ],
  ...over,
})

export const ruleView = (over: Partial<AlertRuleView> = {}): AlertRuleView => ({
  id: 'r1',
  code: 'ADS_HIGH_SPEND_LOW_RETURN',
  domain: 'ADS',
  domainLabel: '广告',
  name: '高花费低产出',
  description: '近期花费高、广告成本销售比过高的广告活动',
  type: 'ads.high-spend-low-return',
  custom: false,
  enabled: true,
  severity: 'WARNING',
  cooldownMinutes: 1440,
  params: { windowDays: 7, minSpend: 20, minClicks: 30, acosThreshold: 1 },
  defaultParams: { windowDays: 7, minSpend: 20, minClicks: 30, acosThreshold: 1 },
  scope: {},
  scopeSupport: { stores: true, skus: false },
  conditionGroups: null,
  conditionText: null,
  notifyFrequency: 'IMMEDIATE',
  escalation: [],
  currentVersion: 2,
  version: 4,
  updatedAt: '2026-10-21T00:00:00.000Z',
  stats: { windowDays: 90, hits: 12, open: 2, handled: 8, falsePositive: 2, falsePositiveRate: 0.25, avgHandleHours: 6.5, truncated: false },
  versions: [
    {
      versionNo: 2,
      changedByName: '甲',
      changeReason: '大促期间放宽',
      createdAt: '2026-10-21T00:00:00.000Z',
      params: { windowDays: 7, minSpend: 20 },
      severity: 'WARNING',
      cooldownMinutes: 1440,
      enabled: true,
      scope: {},
    },
    {
      versionNo: 1,
      changedByName: '系统',
      changeReason: '系统预置规则',
      createdAt: '2026-10-01T00:00:00.000Z',
      params: { windowDays: 7 },
      severity: null,
      cooldownMinutes: null,
      enabled: null,
      scope: null,
    },
  ],
  ...over,
})

export const rulesResponse = (items: AlertRuleView[] = [ruleView()], over: Partial<AlertRulesResponse> = {}): AlertRulesResponse => ({
  state: items.length > 0 ? 'OK' : 'NO_DATA',
  note: null,
  items,
  timezone: 'America/Los_Angeles',
  unconnected: [{ key: 'INV_REALTIME_STOCKOUT', domain: 'INVENTORY', name: '实时断货', reason: '实时断货预警依赖亚马逊小时库存推送，推送接收端尚未建成' }],
  members: [
    { id: 'user-1', name: '甲' },
    { id: 'user-2', name: '乙' },
  ],
  categories: ['家居/厨房'],
  can: { manage: true },
  ...over,
})
