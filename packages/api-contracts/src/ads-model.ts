// 广告数据模型（P3-02）的共用取值（后台任务、接口与前端共用；只有常量与纯函数，没有 zod）。
// 数据库里同样的取值写在迁移 20261110010000_ads_data_model 的检查约束里，真实库测试会逐个核对两边一致。
// 依据：10 章 10.2 广告行；freeze/models.md M-P3-02。

/** 日指标与小时指标能挂的对象：活动、广告组、广告、投放对象、关键词。 */
export const ADS_METRIC_ENTITY_TYPES = ['CAMPAIGN', 'AD_GROUP', 'AD', 'TARGET', 'KEYWORD'] as const
export type AdsMetricEntityType = (typeof ADS_METRIC_ENTITY_TYPES)[number]
export const ADS_METRIC_ENTITY_LABEL: Record<AdsMetricEntityType, string> = {
  CAMPAIGN: '广告活动',
  AD_GROUP: '广告组',
  AD: '广告',
  TARGET: '投放对象',
  KEYWORD: '关键词',
}

/** 投放对象的类别：关键词、商品、类目、受众。 */
export const ADS_TARGET_KINDS = ['KEYWORD', 'PRODUCT', 'CATEGORY', 'AUDIENCE'] as const
export type AdsTargetKind = (typeof ADS_TARGET_KINDS)[number]
export const ADS_TARGET_KIND_LABEL: Record<AdsTargetKind, string> = { KEYWORD: '关键词', PRODUCT: '商品', CATEGORY: '类目', AUDIENCE: '受众' }

/** 否定投放的层级：活动级、广告组级（广告组级必须有广告组编号）。 */
export const ADS_NEGATIVE_LEVELS = ['CAMPAIGN', 'AD_GROUP'] as const
export type AdsNegativeLevel = (typeof ADS_NEGATIVE_LEVELS)[number]
export const ADS_NEGATIVE_LEVEL_LABEL: Record<AdsNegativeLevel, string> = { CAMPAIGN: '活动级', AD_GROUP: '广告组级' }

/** 广告活动的投放方式：自动、手动。 */
export const ADS_TARGETING_TYPES = ['AUTO', 'MANUAL'] as const
export type AdsTargetingType = (typeof ADS_TARGETING_TYPES)[number]
export const ADS_TARGETING_TYPE_LABEL: Record<AdsTargetingType, string> = { AUTO: '自动投放', MANUAL: '手动投放' }

/**
 * 日指标表里金额与订单数的列名：AdsMetric 沿用原列名 cost 与 purchases，其余新表按冻结文档叫 spend 与 orders。
 * 汇总派生（P3-04）读多张表时按这张对照表取列，不要在各处各写一遍。
 */
export const ADS_METRIC_COLUMNS = {
  AdsMetric: { spend: 'cost', orders: 'purchases' },
  AdsTermMetric: { spend: 'cost', orders: 'purchases' },
  AdsPlacementMetric: { spend: 'spend', orders: 'orders' },
  AdsAdvertisedProductMetric: { spend: 'spend', orders: 'orders' },
  AdsPerformanceHourly: { spend: 'spend', orders: 'orders' },
} as const

/** 广告账户与档案的对应状态：统一接口还没发现账户编号时档案上的 adsAccountId 为空，页面写“未发现广告账户”，不显示成空串。 */
export function adsAccountRefState(profile: { adsAccountId: string | null | undefined }): { discovered: true; adsAccountId: string } | { discovered: false; label: string } {
  const id = profile.adsAccountId?.trim()
  return id ? { discovered: true, adsAccountId: id } : { discovered: false, label: '未发现广告账户：统一接口尚未返回该档案对应的账户编号' }
}
