// 预警规则阈值的可调项（P5-01，09 章 9.1 规则配置）。每种评估器类型一份：键、中文名、取值范围、说明。
// 范围与评估器读取阈值时的夹取范围保持一致（apps/worker/src/alerts/*-evaluator.ts 里的 numberParam），规则页的表单与接口校验都用它，
// 超出范围直接拒绝，不靠评估器悄悄夹取（否则页面上写的值与实际生效的值不一致）。
// 本文件不引入 zod，也没有模块级函数调用：只放字面量，前端规则页懒加载，首屏不受影响。

export type AlertParamOption = { value: string; label: string }
export type AlertParamSpec =
  | { kind: 'number'; key: string; label: string; min: number; max: number; unit?: string; integer?: boolean; nullable?: boolean; help?: string }
  | { kind: 'percent'; key: string; label: string; min: number; max: number; help?: string }
  | { kind: 'choices'; key: string; label: string; options: readonly AlertParamOption[]; help?: string }

const days = (key: string, label: string, min: number, max: number, help?: string): AlertParamSpec => ({ kind: 'number', key, label, min, max, unit: '天', integer: true, help })
const money = (key: string, label: string, min: number, help?: string): AlertParamSpec => ({ kind: 'number', key, label, min, max: 1_000_000, unit: '美元', help })
const count = (key: string, label: string, min: number, max: number, unit: string, help?: string): AlertParamSpec => ({ kind: 'number', key, label, min, max, unit, integer: true, help })

export const ALERT_PARAM_SPECS: Readonly<Record<string, readonly AlertParamSpec[]>> = {
  'inventory.stockout-risk': [
    {
      kind: 'choices',
      key: 'levels',
      label: '提醒的风险等级',
      options: [
        { value: 'HIGH', label: '高风险（断货日早于最快补货到仓日）' },
        { value: 'MEDIUM', label: '中风险（断货日落在安全库存之内）' },
      ],
    },
  ],
  'inventory.excess': [],
  'inventory.aging-tier': [days('warnDays', '提前预警天数', 1, 365)],
  'inventory.low-level-fee': [],
  'inventory.stranded': [],
  'inbound.discrepancy': [
    {
      kind: 'choices',
      key: 'kinds',
      label: '差异种类',
      options: [
        { value: 'SHORT', label: '少收' },
        { value: 'OVER', label: '多收' },
        { value: 'NONCOMPLIANCE', label: '不合规' },
      ],
    },
  ],
  'fee.size-tier-change': [days('windowDays', '保持提醒的天数', 1, 30)],
  'settlement.discrepancy': [days('lookbackDays', '回看结算周期（天）', 1, 365), money('minDiffAmount', '差额下限', 0.01)],
  'fee.overcharge': [
    money('minOverchargeAmount', '疑似多收合计下限', 0.01),
    {
      kind: 'choices',
      key: 'kinds',
      label: '费用类别',
      options: [
        { value: 'FULFILLMENT', label: '配送费' },
        { value: 'COMMISSION', label: '佣金' },
        { value: 'STORAGE', label: '仓储费' },
        { value: 'INBOUND_PLACEMENT', label: '入仓配置费' },
      ],
    },
  ],
  'reimbursement.deadline': [days('warnDays', '距申请期限不超过', 1, 365)],
  'returns.abnormal-rate': [
    days('windowDays', '回看天数', 7, 180),
    { kind: 'percent', key: 'rateThreshold', label: '退货率阈值', min: 0.01, max: 1 },
    count('minReturnedUnits', '最小退货件数', 1, 100_000, '件'),
    count('minSoldUnits', '最小销售件数', 1, 1_000_000, '件'),
  ],
  'ads.high-spend-low-return': [
    days('windowDays', '回看天数', 1, 60),
    money('minSpend', '花费下限', 0.01),
    count('minClicks', '点击下限', 1, 1_000_000, '次'),
    { kind: 'percent', key: 'acosThreshold', label: '广告成本销售比阈值', min: 0.05, max: 100, help: '100% 表示花的钱不低于卖的钱' },
  ],
  'ads.stockout-advertising': [days('lookbackDays', '回看天数', 1, 14), money('minSpend', '花费下限', 0.01), days('maxSnapshotAgeDays', '库存快照最长天数', 1, 30)],
  'ads.out-of-budget': [],
  'ads.cpc-surge': [
    days('recentDays', '最近天数', 1, 14),
    days('baselineDays', '基线天数', 3, 60),
    { kind: 'number', key: 'ratio', label: '突增倍数', min: 1.05, max: 20, unit: '倍' },
    count('minClicks', '最近点击下限', 1, 1_000_000, '次'),
    count('minBaselineClicks', '基线点击下限', 1, 1_000_000, '次'),
  ],
  'listing.issue-new': [
    days('windowDays', '回看天数', 1, 30),
    {
      kind: 'choices',
      key: 'severities',
      label: '严重度',
      options: [
        { value: 'ERROR', label: '错误' },
        { value: 'WARNING', label: '警告' },
      ],
    },
    {
      kind: 'choices',
      key: 'kinds',
      label: '问题种类',
      options: [
        { value: 'ISSUE', label: '刊登问题' },
        { value: 'COMPLIANCE', label: '合规' },
      ],
    },
  ],
  'listing.search-suppressed': [],
  'listing.content-changed-by-others': [
    days('windowDays', '回看天数', 1, 30),
    {
      kind: 'choices',
      key: 'actors',
      label: '修改人',
      options: [
        { value: 'OTHER', label: '他人' },
        { value: 'UNKNOWN', label: '未知（可能是自己在卖家后台改的）' },
      ],
    },
  ],
  'pricing.featured-offer-lost': [days('lookbackDays', '回看天数', 1, 30)],
  'pricing.price-health': [
    {
      kind: 'choices',
      key: 'states',
      label: '价格健康状态',
      options: [
        { value: 'ABOVE_EXPECTED', label: '价格高于预期' },
        { value: 'LOST_ELIGIBILITY', label: '因价格失去资格' },
      ],
    },
    { kind: 'percent', key: 'minGapRatio', label: '价格高出预期的最小比例', min: 0, max: 5 },
    days('lostLookbackDays', '失去资格回看天数', 1, 30),
  ],
  'pricing.hijack-offer': [days('lookbackDays', '只看最近几天内新出现的', 1, 30), count('minOffers', '其他报价方至少', 1, 20, '个', '不含跟卖白名单里的卖家')],
  'promotions.stacking': [
    count('minStack', '同期叠加促销数下限', 2, 10, '个'),
    { kind: 'percent', key: 'minDepthPct', label: '叠加后折扣深度下限', min: 0.05, max: 0.95, help: '叠加数或折扣深度任一达到下限就提醒；深度按最近一次价格折算，算不出深度的促销只计数' },
  ],
  'reviews.negative-topic-rising': [
    days('lookbackDays', '回看天数', 7, 90),
    {
      kind: 'choices',
      key: 'kinds',
      label: '上升形式',
      options: [
        { value: 'NEW', label: '新进入前 10' },
        { value: 'MENTIONS_UP', label: '提及量增加' },
        { value: 'RANK_UP', label: '名次上升' },
      ],
    },
    count('minRankRise', '名次至少上升', 1, 9, '位'),
    count('minMentionLow', '提及量下限', 0, 1_000_000, '次'),
  ],
  'system.sync-failed': [],
  'system.auth-expiring': [
    { kind: 'number', key: 'tokenMaxAgeDays', label: '授权最长年龄', min: 30, max: 3650, unit: '天', integer: true, nullable: true, help: '留空表示不按年龄推算（亚马逊没有公布固定有效期）' },
    days('warnBeforeDays', '提前提醒天数', 1, 365),
  ],
  'system.fx-failed': [count('minFailures', '连续失败次数', 1, 30, '次')],
  'system.write-switch-closed': [],
  'account.status-changed': [
    days('lookbackDays', '回看天数', 1, 30),
    {
      kind: 'choices',
      key: 'statuses',
      label: '提醒的目标状态',
      options: [
        { value: 'AT_RISK', label: '有风险' },
        { value: 'DEACTIVATED', label: '停用' },
      ],
    },
  ],
  'account.health-decline': [
    days('maxAgeDays', '快照最长天数', 1, 14),
    {
      kind: 'choices',
      key: 'groups',
      label: '关注的指标分组',
      options: [
        { value: 'ORDER_DEFECT', label: '订单缺陷' },
        { value: 'POLICY', label: '政策合规' },
        { value: 'OTHER', label: '其他指标' },
      ],
    },
  ],
  'audit.pii-bulk-view': [count('windowMinutes', '统计时长', 5, 1440, '分钟'), count('maxViews', '查看次数达到', 1, 10_000, '次', '同一个人在统计时长内看到买家信息明文的次数达到该值就预警')],
}

// 范围里的店铺、SKU 对哪些评估器不生效：广告活动、结算单、数据来源、企业设置这类预警对象没有 SKU 维度；汇率与写入开关是企业级的，没有店铺维度。
const NO_SKU_SCOPE = [
  'settlement.discrepancy',
  'ads.high-spend-low-return',
  'ads.cpc-surge',
  'ads.out-of-budget',
  'system.sync-failed',
  'system.auth-expiring',
  'system.fx-failed',
  'system.write-switch-closed',
  'account.status-changed',
  'account.health-decline',
  'audit.pii-bulk-view',
  // P6-16：自定义指标规则按店铺判断，没有 SKU 维度
  'CUSTOM_METRIC',
]
const NO_STORE_SCOPE = ['system.fx-failed', 'system.write-switch-closed', 'audit.pii-bulk-view']
export const alertScopeSupportOf = (type: string): { stores: boolean; skus: boolean } => ({ stores: !NO_STORE_SCOPE.includes(type), skus: !NO_SKU_SCOPE.includes(type) })

/** 评估器类型的可调项；未登记的类型没有可调项。 */
export const alertParamSpecsOf = (type: string): readonly AlertParamSpec[] => ALERT_PARAM_SPECS[type] ?? []

export type AlertParamsCheck = { ok: true; params: Record<string, unknown> } | { ok: false; errors: Record<string, string[]> }

/**
 * 校验并合并阈值：只允许该类型登记过的键；没给的键沿用 current（通常是规则当前值或默认值）。
 * 数字必须在范围内（整数项必须是整数），可空项允许 null；多选项必须是登记过的取值、至少选一项。
 */
export function checkAlertParams(type: string, input: Readonly<Record<string, unknown>>, current: Readonly<Record<string, unknown>>): AlertParamsCheck {
  const specs = alertParamSpecsOf(type)
  const errors: Record<string, string[]> = {}
  const result: Record<string, unknown> = {}
  const known = new Set(specs.map(spec => spec.key))
  for (const key of Object.keys(input)) if (!known.has(key)) errors[key] = ['该规则没有这个阈值']
  for (const spec of specs) {
    const given = Object.prototype.hasOwnProperty.call(input, spec.key)
    const value = given ? input[spec.key] : current[spec.key]
    if (spec.kind === 'choices') {
      const allowed = spec.options.map(option => option.value)
      if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !allowed.includes(item))) errors[spec.key] = [`${spec.label}至少选择一项，且只能选列出的取值`]
      else result[spec.key] = allowed.filter(item => value.includes(item))
      continue
    }
    if (value === null || value === undefined) {
      if (spec.kind === 'number' && spec.nullable) result[spec.key] = null
      else errors[spec.key] = [`${spec.label}不能为空`]
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) errors[spec.key] = [`${spec.label}必须是数字`]
    else if (value < spec.min || value > spec.max) errors[spec.key] = [`${spec.label}必须在 ${spec.min} 到 ${spec.max} 之间`]
    else if (spec.kind === 'number' && spec.integer && !Number.isInteger(value)) errors[spec.key] = [`${spec.label}必须是整数`]
    else result[spec.key] = value
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, params: result }
}
