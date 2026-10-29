// 标签模板与箱号规则契约（P6-12，16 章第 5.1、5.2 节；freeze/api.md `/label-templates*`）。
// 本文件只放常量、类型与纯函数，没有 zod（前端与接口共用同一份校验与箱号预览）；请求体与列表查询的校验在 label-template-query.ts。

export const LABEL_TEMPLATE_READ = 'inbound.read'
export const LABEL_TEMPLATE_MANAGE = 'labeltemplate.manage'
/** 生成自定义箱标签与商品标签（本地导出，不调用亚马逊写接口）要的权限；另外要有导出权限，文件在导出中心下载。 */
export const LABEL_GENERATE_PERMISSION = 'inbound.plan.write'
export const LABEL_EXPORT_PERMISSION = 'export.create'
export const LABEL_TEMPLATE_PATH = '/app/settings/label-templates'
/** 每个企业最多保存多少个标签模板。 */
export const LABEL_TEMPLATE_LIMIT = 50
export const LABEL_NAME_MAX = 40
export const LABEL_ORIGIN_MAX = 40
export const LABEL_TEMPLATE_BLOCKED_NO_PERMISSION = '你没有维护标签模板的权限（需要“新增、修改、删除标签模板与箱号规则”），请联系管理员'

export const LABEL_TEMPLATE_ACTIONS = {
  created: 'LABEL_TEMPLATE_CREATED',
  updated: 'LABEL_TEMPLATE_UPDATED',
  deleted: 'LABEL_TEMPLATE_DELETED',
  boxRequested: 'FBA_INBOUND_CUSTOM_LABELS_REQUESTED',
  itemRequested: 'FBA_INBOUND_ITEM_LABELS_REQUESTED',
  generated: 'LABEL_PDF_GENERATED',
} as const

// ---------------------------------------------------------------- 纸张
export const LABEL_PAPERS = ['THERMAL_4X6', 'A4_2UP', 'A4_4UP'] as const
export type LabelPaper = (typeof LABEL_PAPERS)[number]
export interface LabelPaperSpec {
  label: string
  /** 页面宽高，单位 pt（1/72 英寸）。 */
  widthPt: number
  heightPt: number
  /** 一页上的标签数 = 列数 × 行数；标签按从左到右、从上到下的顺序排。 */
  cols: number
  rows: number
  /** 向亚马逊取箱标签时用的纸张类型（v0 getLabels 的 PageType；以亚马逊实际返回为准，未对真实店铺实测）。 */
  amazonPageType: string
  /** 能不能把文字直接追加在亚马逊标签的空白区：一页只有一张标签的纸张才能判断空白区，多张拼版不行，只能附页。 */
  overlayAllowed: boolean
}
export const LABEL_PAPER_SPEC: Record<LabelPaper, LabelPaperSpec> = {
  THERMAL_4X6: { label: '热敏纸 4×6 英寸', widthPt: 288, heightPt: 432, cols: 1, rows: 1, amazonPageType: 'PackageLabel_Thermal_NonPCP', overlayAllowed: true },
  A4_2UP: { label: 'A4 每页 2 张', widthPt: 595.28, heightPt: 841.89, cols: 1, rows: 2, amazonPageType: 'PackageLabel_A4_2', overlayAllowed: false },
  A4_4UP: { label: 'A4 每页 4 张', widthPt: 595.28, heightPt: 841.89, cols: 2, rows: 2, amazonPageType: 'PackageLabel_A4_4', overlayAllowed: false },
}
export const labelsPerPage = (paper: LabelPaper) => LABEL_PAPER_SPEC[paper].cols * LABEL_PAPER_SPEC[paper].rows

// ---------------------------------------------------------------- 勾选项
export const LABEL_ORDERS = ['AMAZON', 'OURS'] as const
export type LabelOrder = (typeof LABEL_ORDERS)[number]
export const LABEL_ORDER_LABEL: Record<LabelOrder, string> = { AMAZON: '亚马逊原始顺序', OURS: '我方箱号顺序' }

export interface LabelOptions {
  showOrigin: boolean
  /** 原产地文字，印在箱标签附加内容里，例如 Made in China。 */
  originText: string
  showSku: boolean
  showProductName: boolean
  /** 只有箱内只有一种商品时才会印。 */
  showFnsku: boolean
  showUnits: boolean
  showBoxNo: boolean
  /** 每个货件的第一页加一张“任务名称页”。 */
  taskNamePage: boolean
  /** 直接追加在亚马逊标签的空白区；空间不够时自动改成附页。默认关闭，默认用附页。 */
  appendToOriginal: boolean
  order: LabelOrder
}
export const DEFAULT_LABEL_OPTIONS: LabelOptions = {
  showOrigin: true,
  originText: 'Made in China',
  showSku: true,
  showProductName: false,
  showFnsku: false,
  showUnits: true,
  showBoxNo: true,
  taskNamePage: false,
  appendToOriginal: false,
  order: 'AMAZON',
}

type ToggleKey = 'showOrigin' | 'showSku' | 'showProductName' | 'showFnsku' | 'showUnits' | 'showBoxNo' | 'taskNamePage' | 'appendToOriginal'
export interface LabelOptionMeta {
  key: ToggleKey
  label: string
  /** 每个选项写明什么条件下才会真正印出来。 */
  condition: string
}
export const LABEL_OPTION_META: readonly LabelOptionMeta[] = [
  { key: 'showOrigin', label: '原产地', condition: '每个箱子都印；文字在下面填写。' },
  { key: 'showSku', label: 'SKU', condition: '只有能确定每个箱子装了什么时才印：计划里所有箱子的内容完全一致，或所有箱子都只装同一个 SKU。' },
  { key: 'showProductName', label: '品名', condition: '同 SKU；品名取自入仓计划里的商品，没有品名的商品只印 SKU。含中文时 worker 要配置中文字体，否则生成会失败并写明原因。' },
  { key: 'showFnsku', label: 'FNSKU', condition: '只有箱内只有一种商品并且该商品有 FNSKU 时才印。' },
  { key: 'showUnits', label: '箱内件数', condition: '只有所有箱子装的件数完全相同才印；每箱件数不同的计划不印，避免印错。' },
  { key: 'showBoxNo', label: '我方箱号', condition: '按下面的箱号规则生成，从亚马逊标签上的箱序号顺序往下编；每个货件的编号接着上一个货件往下排（生成时可指定起始序号）。' },
  { key: 'taskNamePage', label: '每个货件前加任务名称页', condition: '每个货件生成的文件第一页是一张任务名称页：计划名称、货件编号、目的运营中心、箱数。' },
  { key: 'appendToOriginal', label: '追加到原标签', condition: '只有热敏纸 4×6 可用：在原标签空白区追加文字，不压住条码；空间不够的箱子自动改成“追加一张附页”。A4 拼版纸张只能附页。默认关闭。' },
]
/** 勾选额外内容时必须看到的提醒。 */
export const LABEL_SIGN_WARNING = '在亚马逊箱标签上或旁边追加内容，对运营中心签收是否有影响，需要你自行向亚马逊确认；亚马逊标签本身不会被改动，追加的内容只是附加文字。'
export const LABEL_FONT_NOTE =
  '标签上的固定文字用英文，不依赖字体；品名、原产地等含中文的内容需要 worker 配置中文字体（环境变量 LABEL_FONT_PATH，指向 TTF 或 OTF 字体文件），没有配置时含中文的标签会生成失败并写明原因，不会印成乱码。'

// ---------------------------------------------------------------- 箱号规则
export interface BoxNoRule {
  prefix: string
  /** 是否在前缀后面带入仓计划编号（取计划的亚马逊编号，没有则取我方计划编号的末 6 位）。 */
  includePlanNo: boolean
  /** 递增数字的位数（不足补零），1 到 8。 */
  digits: number
  /** 起始序号。 */
  start: number
  suffix: string
  joiner: string
}
export const DEFAULT_BOX_NO_RULE: BoxNoRule = { prefix: 'BOX', includePlanNo: false, digits: 3, start: 1, suffix: '', joiner: '-' }
export const BOX_NO_PART_MAX = 12
export const BOX_NO_JOINER_MAX = 3
export const BOX_NO_MAX_LENGTH = 40
export const BOX_NO_DIGITS_MAX = 8
export const BOX_NO_START_MAX = 99_999_999
const BOX_NO_CHARS = /^[A-Za-z0-9_.#/-]*$/

/** 第 `index` 个箱子（从 0 起）的我方箱号：前缀、计划号、递增数字、后缀依次用连接符拼接，空的部分跳过。 */
export function formatBoxNo(rule: BoxNoRule, planNo: string, index: number, startAt: number = rule.start): string {
  const number = String(startAt + index).padStart(rule.digits, '0')
  const parts = [rule.prefix, rule.includePlanNo ? planNo : '', number, rule.suffix].filter(part => part.length > 0)
  return parts.join(rule.joiner)
}
/** 规则预览：前几个箱号，页面实时显示给用户看。 */
export const boxNoPreview = (rule: BoxNoRule, planNo = 'PLAN', count = 3) => Array.from({ length: count }, (_, index) => formatBoxNo(rule, planNo, index))

export interface LabelIssue {
  field: string
  message: string
}
/** 箱号规则校验：字符只允许字母、数字和 _ . # / -（箱号要印在标签上并可能做成条码，不收中文与空格）。 */
export function validateBoxNoRule(rule: BoxNoRule, planNo = 'PLAN'): LabelIssue[] {
  const issues: LabelIssue[] = []
  const check = (field: keyof Pick<BoxNoRule, 'prefix' | 'suffix' | 'joiner'>, label: string, max: number) => {
    const value = rule[field]
    if (value.length > max) issues.push({ field: `boxNoRule.${field}`, message: `${label}最多 ${max} 个字符` })
    else if (!BOX_NO_CHARS.test(value)) issues.push({ field: `boxNoRule.${field}`, message: `${label}只能用字母、数字和 _ . # / -` })
  }
  check('prefix', '前缀', BOX_NO_PART_MAX)
  check('suffix', '后缀', BOX_NO_PART_MAX)
  check('joiner', '连接符', BOX_NO_JOINER_MAX)
  if (!Number.isInteger(rule.digits) || rule.digits < 1 || rule.digits > BOX_NO_DIGITS_MAX) issues.push({ field: 'boxNoRule.digits', message: `数字位数是 1 到 ${BOX_NO_DIGITS_MAX} 之间的整数` })
  if (!Number.isInteger(rule.start) || rule.start < 0 || rule.start > BOX_NO_START_MAX) issues.push({ field: 'boxNoRule.start', message: `起始序号是 0 到 ${BOX_NO_START_MAX} 之间的整数` })
  if (issues.length === 0 && formatBoxNo(rule, planNo, 0).length > BOX_NO_MAX_LENGTH)
    issues.push({ field: 'boxNoRule', message: `箱号太长（最多 ${BOX_NO_MAX_LENGTH} 个字符），请缩短前缀、后缀或位数` })
  return issues
}

export interface LabelTemplateInput {
  name: string
  paper: LabelPaper
  options: LabelOptions
  boxNoRule: BoxNoRule
}
/** 模板整体校验（接口与页面共用）：名称、原产地文字、纸张与选项的组合、箱号规则。 */
export function validateLabelTemplate(input: LabelTemplateInput): LabelIssue[] {
  const issues: LabelIssue[] = []
  const name = input.name.trim()
  if (name.length === 0) issues.push({ field: 'name', message: '请填写模板名称' })
  else if (name.length > LABEL_NAME_MAX) issues.push({ field: 'name', message: `模板名称最多 ${LABEL_NAME_MAX} 个字符` })
  if (input.options.originText.length > LABEL_ORIGIN_MAX) issues.push({ field: 'options.originText', message: `原产地文字最多 ${LABEL_ORIGIN_MAX} 个字符` })
  if (input.options.showOrigin && input.options.originText.trim().length === 0) issues.push({ field: 'options.originText', message: '勾选了原产地，请填写原产地文字' })
  const spec = LABEL_PAPER_SPEC[input.paper]
  if (input.options.appendToOriginal && !spec.overlayAllowed) issues.push({ field: 'options.appendToOriginal', message: `${spec.label}是多张拼版，不能追加到原标签，只能附页；请关闭“追加到原标签”` })
  if (input.options.order === 'OURS' && labelsPerPage(input.paper) > 1)
    issues.push({ field: 'options.order', message: `${spec.label}一页有多张标签，不能按我方箱号重新排序；请选“亚马逊原始顺序”或改用热敏纸` })
  return [...issues, ...validateBoxNoRule(input.boxNoRule)]
}

// ---------------------------------------------------------------- 行与响应
export interface LabelTemplateRow {
  id: string
  name: string
  paper: LabelPaper
  options: LabelOptions
  boxNoRule: BoxNoRule
  isDefault: boolean
  /** 乐观锁版本号：修改时原样带回。 */
  version: number
  createdAt: string
  updatedAt: string
}
export interface LabelTemplateListResponse {
  items: LabelTemplateRow[]
  page: number
  pageSize: number
  total: number
  summary: { total: number; defaultName: string | null }
  canManage: boolean
  manageBlockedReason: string | null
}
/** 入仓计划“标签”页签里按货件统计的生成次数。 */
export interface LabelPrintStat {
  shipmentRowId: string
  shipmentId: string
  /** 货件的箱数（运输方案确认后才有）。 */
  boxes: number | null
  /** 自定义箱标签生成过几次（只数成功生成的文件）。 */
  customCount: number
  /** 商品标签生成过几次。 */
  itemCount: number
  lastPrintedAt: string | null
  /** 已经从亚马逊取到箱标签文件的纸张类型：自定义箱标签以它为底，没有对应纸张的要先去取。 */
  readyPageTypes: string[]
}

/** 把数据库里存的 JSON 补齐成完整的选项（旧数据缺字段时用默认值，不信任存储内容）。 */
export function normalizeLabelOptions(value: unknown): LabelOptions {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const flag = (key: ToggleKey) => (typeof source[key] === 'boolean' ? (source[key] as boolean) : DEFAULT_LABEL_OPTIONS[key])
  return {
    showOrigin: flag('showOrigin'),
    originText: typeof source.originText === 'string' ? source.originText : DEFAULT_LABEL_OPTIONS.originText,
    showSku: flag('showSku'),
    showProductName: flag('showProductName'),
    showFnsku: flag('showFnsku'),
    showUnits: flag('showUnits'),
    showBoxNo: flag('showBoxNo'),
    taskNamePage: flag('taskNamePage'),
    appendToOriginal: flag('appendToOriginal'),
    order: source.order === 'OURS' ? 'OURS' : 'AMAZON',
  }
}
export function normalizeBoxNoRule(value: unknown): BoxNoRule {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const text = (key: 'prefix' | 'suffix' | 'joiner') => (typeof source[key] === 'string' ? (source[key] as string) : DEFAULT_BOX_NO_RULE[key])
  const int = (key: 'digits' | 'start') => (typeof source[key] === 'number' && Number.isInteger(source[key]) ? (source[key] as number) : DEFAULT_BOX_NO_RULE[key])
  return { prefix: text('prefix'), includePlanNo: source.includePlanNo === true, digits: int('digits'), start: int('start'), suffix: text('suffix'), joiner: text('joiner') }
}
