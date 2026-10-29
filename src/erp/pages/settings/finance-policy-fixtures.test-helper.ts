import {
  ALLOCATION_BASES,
  ALLOCATION_BASIS_LABEL,
  DEFAULT_POLICY,
  FX_RATE_RULES,
  FX_RATE_RULE_LABEL,
  INVENTORY_COSTINGS,
  INVENTORY_COSTING_LABEL,
  POLICY_KEY_LABEL,
  PROFIT_BASES,
  PROFIT_BASIS_LABEL,
  policyActionsOf,
  type FinancePolicyResponse,
  type PolicyFieldInfo,
  type PolicyVersionView,
} from '@nova/api-contracts'

// 财务口径页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

const opts = <T extends string>(values: readonly T[], labels: Readonly<Record<T, string>>) => values.map(value => ({ value, label: labels[value] }))

export const policyFields = (): PolicyFieldInfo[] => [
  {
    key: 'revenueRecognition',
    label: POLICY_KEY_LABEL.revenueRecognition,
    description: '利润按哪一天确认收入',
    consumer: 'RECORDED',
    consumerNote: '利润页仍可随时切换三种口径查看，默认口径暂未跟随本设置。',
    editable: true,
    options: opts(PROFIT_BASES, PROFIT_BASIS_LABEL),
  },
  {
    key: 'inventoryCostMethod',
    label: POLICY_KEY_LABEL.inventoryCostMethod,
    description: '销售成本怎么从入库批次里取',
    consumer: 'WIRED',
    consumerNote: '审批通过后写入企业设置，利润日表重算与库存成本估算按它计价。',
    editable: true,
    options: opts(INVENTORY_COSTINGS, INVENTORY_COSTING_LABEL),
  },
  {
    key: 'fxRateRule',
    label: POLICY_KEY_LABEL.fxRateRule,
    description: '成本与费用折美元用哪一天的汇率',
    consumer: 'WIRED',
    consumerNote: '利润计算已按这条规则折算。',
    editable: false,
    options: opts(FX_RATE_RULES, FX_RATE_RULE_LABEL),
  },
  {
    key: 'adsAllocationMode',
    label: POLICY_KEY_LABEL.adsAllocationMode,
    description: '账户级广告花费怎么分摊',
    consumer: 'WIRED',
    consumerNote: '利润日表重算时按它分摊广告。',
    editable: true,
    options: opts(ALLOCATION_BASES, ALLOCATION_BASIS_LABEL),
  },
  {
    key: 'storeFeeAllocation',
    label: POLICY_KEY_LABEL.storeFeeAllocation,
    description: '店铺级费用怎么分摊',
    consumer: 'WIRED',
    consumerNote: '店铺级费用的分摊已接入利润日表，在“费用分摊规则”页按费用项配置。',
    editable: true,
    options: opts(ALLOCATION_BASES, ALLOCATION_BASIS_LABEL),
  },
]

export const policyVersion = (over: Partial<PolicyVersionView> = {}): PolicyVersionView => ({
  id: 'fp-1',
  versionNo: 1,
  status: 'ACTIVE',
  effectiveFrom: '2026-10-01',
  ...DEFAULT_POLICY,
  inventoryCostMethod: 'MONTH_AVG',
  reason: '改用月末加权平均核算存货',
  version: 2,
  createdBy: 'u-maker',
  createdByName: '王会计',
  createdAt: '2026-10-01T02:00:00.000Z',
  decidedBy: 'u-checker',
  decidedByName: '李财务',
  decidedAt: '2026-10-01T03:00:00.000Z',
  decisionComment: '同意',
  withdrawn: false,
  mine: false,
  replacedAt: null,
  ...over,
})

/** canWrite 与 userId 决定动作可用性（和服务端同一个纯函数）。 */
export const policyData = (over: Partial<FinancePolicyResponse> = {}, options: { canWrite?: boolean; userId?: string } = {}): FinancePolicyResponse => {
  const pending = over.pending ?? null
  return {
    current: { source: 'DEFAULT', versionNo: 0, effectiveFrom: null, values: { ...DEFAULT_POLICY }, inventoryMethodValid: true },
    pending,
    history: [],
    historyTruncated: false,
    latestVersionNo: 0,
    fields: policyFields(),
    today: '2026-10-23',
    actions: policyActionsOf({ canWrite: options.canWrite ?? true, pending, userId: options.userId ?? 'u-me' }),
    frozenPeriodCount: 0,
    ...over,
  }
}
