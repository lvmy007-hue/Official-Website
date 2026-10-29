// 退货原因常见代码与中文释义（报告 reason 列）。从 returns.ts 拆出来，让 returns-reason.ts 不依赖带 zod 的 returns.ts（前端首屏路径不引入 zod）。
// 没登记的代码原样显示；企业可以在退货原因映射里改释义与大类（P6-13）。

export const RETURN_REASON_LABEL: Readonly<Record<string, string>> = {
  DEFECTIVE: '商品有缺陷',
  NOT_AS_DESCRIBED: '与描述不符',
  QUALITY_UNACCEPTABLE: '质量不满意',
  MISSING_PARTS: '缺少配件',
  DAMAGED_BY_FC: '仓库造成损坏',
  DAMAGED_BY_CARRIER: '承运人造成损坏',
  WRONG_ITEM: '收到错误商品',
  EXTRA_ITEM: '多发商品',
  UNWANTED_ITEM: '不想要了',
  UNAUTHORIZED_PURCHASE: '未经授权的购买',
  ORDERED_WRONG_ITEM: '下错单',
  NOT_COMPATIBLE: '不兼容',
  FOUND_BETTER_PRICE: '发现更低价格',
  NO_REASON_GIVEN: '未说明原因',
  SWITCHEROO: '收到的商品被调包',
  UNDELIVERABLE_REFUSED: '拒收',
  UNDELIVERABLE_UNKNOWN: '无法投递（原因未知）',
  APPAREL_TOO_SMALL: '尺码偏小',
  APPAREL_TOO_LARGE: '尺码偏大',
  APPAREL_STYLE: '款式不喜欢',
  EXCESSIVE_INSTALLATION: '安装过于复杂',
  ARRIVED_LATE: '到货太晚',
}

/** 报告原因列为空时的归并键。 */
export const UNSPECIFIED_REASON_KEY = 'UNSPECIFIED'
