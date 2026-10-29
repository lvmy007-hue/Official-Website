import { ALERT_RULE_DEFS, ALERT_RULE_DOMAIN_LABEL, type AlertRuleDef, type AlertRuleDomain, type AlertRuleSeverity } from './alert-rules.js'

// 预警规则模板（P6-15，16 章第 9 节）：由系统预置规则直接生成，不另存一份数据。
// 每个模板写清“一句话条件”和“适用维度”（预警落在哪种对象上）；“从模板新建”把模板的评估逻辑、严重度、冷却与阈值带进规则配置。
// 新增一条预置规则必须同时在下面的 ALERT_TEMPLATE_TEXT 补文字（单元测试会检查），否则模板页没有说明。

export const ALERT_TEMPLATE_GROUPS = ['INVENTORY', 'ADS', 'SALES', 'TRAFFIC', 'STORE'] as const
export type AlertTemplateGroup = (typeof ALERT_TEMPLATE_GROUPS)[number]
export const ALERT_TEMPLATE_GROUP_LABEL: Readonly<Record<AlertTemplateGroup, string>> = { INVENTORY: '库存', ADS: '广告', SALES: '销售', TRAFFIC: '流量', STORE: '店铺' }

/** 业务域 → 模板分组：财务与售后归“销售”（结算、费用、退货、口碑），商品归“流量”（刊登、搜索、推荐报价、价格），系统与账户归“店铺”。 */
export const ALERT_TEMPLATE_GROUP_OF_DOMAIN: Readonly<Record<AlertRuleDomain, AlertTemplateGroup>> = {
  INVENTORY: 'INVENTORY',
  ADS: 'ADS',
  FINANCE: 'SALES',
  AFTER_SALES: 'SALES',
  PRODUCT: 'TRAFFIC',
  SYSTEM: 'STORE',
}

/** 模板页与“从模板新建”都要求规则名称不超过这个长度（与创建规则的名称上限一致）。 */
export const ALERT_TEMPLATE_NAME_MAX = 60

export const ALERT_TEMPLATE_TEXT: Readonly<Record<string, { condition: string; dimension: string }>> = {
  INV_STOCKOUT_RISK: { condition: '预计断货日早于最快补货到仓日', dimension: 'SKU（按店铺）' },
  INV_EXCESS: { condition: '覆盖天数超过目标覆盖天数乘冗余倍数，或近期无销量仍有库存', dimension: 'SKU（按店铺）' },
  INV_AGING_TIER: { condition: '库存在预警天数内会全部进入库龄附加费收费档', dimension: 'SKU（按店铺）' },
  INV_LOW_LEVEL_FEE: { condition: '库存规划报告显示已被收取或预估会收低库存水平费', dimension: 'SKU（按店铺）' },
  INV_STRANDED: { condition: '滞留库存报告里该 SKU 有滞留数量', dimension: 'SKU（按店铺）' },
  INV_INBOUND_DISCREPANCY: { condition: '已关闭的入仓货件存在未消除的少收、多收或不合规', dimension: '入仓货件' },
  FEE_SIZE_TIER_CHANGE: { condition: '预估配送费报告里 SKU 的尺寸分段与前一天不同', dimension: 'SKU（按店铺）' },
  FIN_SETTLEMENT_DISCREPANCY: { condition: '结算单三方核对有差异，且差额绝对值达到阈值', dimension: '结算单' },
  FIN_FEE_OVERCHARGE: { condition: '最新一次费用核查里同类费用疑似多收的合计达到阈值', dimension: '店铺 × 费用类型' },
  FIN_REIMBURSEMENT_DEADLINE: { condition: '待处理的赔付机会距申请期限不超过预警天数', dimension: '赔付机会' },
  RET_RATE_ABNORMAL: { condition: '回看天数内退货件数除以销售件数达到阈值，且样本够大', dimension: 'ASIN（按店铺）' },
  ADS_HIGH_SPEND_LOW_RETURN: { condition: '回看天数内花费与点击达到下限，且没有销售额或广告成本销售比过高', dimension: '广告活动' },
  ADS_STOCKOUT_ADVERTISING: { condition: '近几天仍有花费的被推广商品，库存快照显示可售为 0', dimension: 'ASIN（按店铺）' },
  ADS_OUT_OF_BUDGET: { condition: '启用中的广告活动，投放状态为预算用完', dimension: '广告活动' },
  ADS_CPC_SURGE: { condition: '最近几天的单次点击成本不低于基线期的指定倍数，且点击够多', dimension: '广告活动' },
  PRD_LISTING_ISSUE_NEW: { condition: '回看天数内出现新的、未解决的刊登问题或合规问题', dimension: 'SKU（按店铺）' },
  PRD_SEARCH_SUPPRESSED: { condition: '有尚未解决的搜索抑制问题', dimension: 'SKU（按店铺）' },
  PRD_CONTENT_CHANGED_BY_OTHERS: { condition: '标题或主图在回看天数内被他人或未知来源修改', dimension: 'SKU（按店铺）' },
  PRD_FEATURED_OFFER_LOST: { condition: '此前获得推荐报价的 ASIN，最近一次观察已不是', dimension: 'ASIN（按店铺）' },
  PRD_PRICE_HEALTH: { condition: '我方价格比推荐报价预期价格高出阈值比例，或因价格失去资格', dimension: 'ASIN（按店铺）' },
  PRD_HIJACK_OFFER: { condition: '竞争摘要里我方 SKU 所在 ASIN 在回看天数内新出现了不在白名单里的其他报价方', dimension: 'SKU（按店铺）' },
  PRD_PROMO_STACKING: { condition: '同一 ASIN 同期叠加的促销数或叠加后的折扣深度达到下限', dimension: 'ASIN（按店铺）' },
  REV_NEGATIVE_TOPIC_RISING: { condition: '负面评论主题新进前 10、提及量上升或名次上升达到阈值', dimension: 'ASIN（按店铺）' },
  SYS_SYNC_FAILED: { condition: '某个数据来源最近一次同步以失败收场', dimension: '店铺 × 数据来源' },
  SYS_AUTH_EXPIRING: { condition: '同步被亚马逊以授权已失效拒绝且之后没有重新授权', dimension: '店铺' },
  SYS_FX_FETCH_FAILED: { condition: '主汇率来源连续获取失败的次数达到阈值', dimension: '汇率来源（企业级）' },
  SYS_WRITE_SWITCH_CLOSED: { condition: '企业级写入开关被系统自动关闭且没有被人工重新开启', dimension: '写入开关（企业级）' },
  SYS_ACCOUNT_STATUS_CHANGED: { condition: '账户状态变成有风险或停用', dimension: '店铺' },
  SYS_ACCOUNT_HEALTH_DECLINE: { condition: '最近一份账户健康快照里有指标未达到报告自带的目标', dimension: '店铺' },
  SYS_PII_BULK_VIEW: { condition: '同一个人在统计时长内查看买家信息明文的次数达到上限', dimension: '成员（企业级）' },
}

export interface AlertTemplateDef {
  code: string
  name: string
  group: AlertTemplateGroup
  groupLabel: string
  domain: AlertRuleDomain
  domainLabel: string
  severity: AlertRuleSeverity
  cooldownMinutes: number
  /** 评估逻辑（创建规则时的 type） */
  type: string
  /** 一句话条件 */
  condition: string
  /** 适用维度：预警落在哪种对象上 */
  dimension: string
  /** 完整说明（来自预置规则） */
  description: string
  /** 默认阈值（“从模板新建”带入） */
  params: Record<string, unknown>
}

export const alertTemplateOf = (def: AlertRuleDef): AlertTemplateDef => {
  const text = ALERT_TEMPLATE_TEXT[def.code]
  const group = ALERT_TEMPLATE_GROUP_OF_DOMAIN[def.domain]
  return {
    code: def.code,
    name: def.name,
    group,
    groupLabel: ALERT_TEMPLATE_GROUP_LABEL[group],
    domain: def.domain,
    domainLabel: ALERT_RULE_DOMAIN_LABEL[def.domain],
    severity: def.severity,
    cooldownMinutes: def.cooldownMinutes,
    type: def.type,
    condition: text?.condition ?? def.description,
    dimension: text?.dimension ?? '见规则说明',
    description: def.description,
    params: { ...def.params },
  }
}

/** 全部模板：按分组顺序（库存、广告、销售、流量、店铺），同组内保持预置规则的顺序。 */
export const buildAlertTemplates = (): AlertTemplateDef[] => {
  const all = ALERT_RULE_DEFS.map(alertTemplateOf)
  return ALERT_TEMPLATE_GROUPS.flatMap(group => all.filter(item => item.group === group))
}

/** 模板带进“新建规则”的默认名称：在模板名后加“（自定义）”，名称过长时截断模板名。 */
export const templateRuleName = (name: string): string => `${name.slice(0, ALERT_TEMPLATE_NAME_MAX - 5)}（自定义）`

export interface AlertTemplateItem extends AlertTemplateDef {
  /** 企业里已有的、用同一评估逻辑的规则条数（预置与自定义合计） */
  ruleCount: number
  /** 其中启用中的条数 */
  enabledCount: number
}

export interface AlertTemplatesResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: AlertTemplateItem[]
  /** 能否按模板新建规则（有预警管理权限） */
  can: { create: boolean }
}
