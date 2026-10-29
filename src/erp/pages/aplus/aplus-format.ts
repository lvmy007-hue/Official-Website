import {
  APLUS_ASIN_PATTERN,
  APLUS_LIMITS,
  APLUS_MODULE_DEFS,
  APLUS_RUN_STATUS_LABEL,
  APLUS_UPLOAD_TYPES,
  aplusModuleIssues,
  type AplusFormModule,
  type AplusModuleType,
  type AplusPendingRun,
  type AplusSectionState,
  type AplusSort,
  type AplusStatus,
  type AplusUploadRow,
  type AplusWriteResult,
  type AplusWriteStatus,
} from '@nova/api-contracts'
import { formatNumber, formatPercent } from '../../format'

// A+ 内容页的纯函数（P4-14）：只做格式化与本地校验，不引入 zod（首屏脚本不能依赖请求校验库）。
// 没有数据写“尚无记录”，没有权限写“无权限”，没接入写“尚未接入”，永远不显示成 0。

export const PAGE_SIZES = [20, 50, 100] as const
export const NONE_TEXT = '尚无记录'

export const SORT_LABEL: Record<AplusSort, string> = { updatedAt: '最近更新', name: '名称', asinCount: '关联 ASIN 数', status: '状态' }
export const SORT_FIELDS = Object.keys(SORT_LABEL) as AplusSort[]

/** 状态标签颜色：被拒用醒目的红色。 */
export const STATUS_COLOR: Record<AplusStatus, string> = { DRAFT: 'default', SUBMITTED: 'processing', APPROVED: 'cyan', REJECTED: 'red', PUBLISHED: 'green' }

/** 区块状态的标题：没有数据写“尚无记录”，没有权限写“无权限”，来源没接上写“尚未接入”。 */
export const SECTION_TITLE: Record<AplusSectionState, string> = { OK: '', NO_DATA: '尚无记录', NOT_CONNECTED: '尚未接入', RESTRICTED: '无权限' }

/** 进行中的写入：排队中·提交审核。 */
export const pendingRunText = (run: Pick<AplusPendingRun, 'status' | 'kindLabel'>): string => `${APLUS_RUN_STATUS_LABEL[run.status]}·${run.kindLabel}`

/** 文件大小：不足 1 MB 用 KB。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return NONE_TEXT
  return bytes >= 1024 * 1024 ? `${formatNumber(bytes / 1024 / 1024, { digits: 2 })} MB` : `${formatNumber(bytes / 1024, { digits: 1 })} KB`
}

/** 要求的图片尺寸文字：970×600 像素；没有图片的模块返回 null。 */
export function imageSizeText(type: AplusModuleType): string | null {
  const size = APLUS_MODULE_DEFS[type].imageSize
  return size ? `${size.width}×${size.height} 像素` : null
}

/** 转化率（百分比，保留 2 位）；没有数据写“尚无记录”。 */
export const conversionText = (value: number | null | undefined): string => (value === null || value === undefined ? NONE_TEXT : formatPercent(value, { digits: 2 }))
/** 转化率差：小数 0.01 = 1 个百分点。 */
export const deltaText = (value: number | null | undefined): string => (value === null || value === undefined ? NONE_TEXT : `${formatNumber(value * 100, { digits: 2, sign: true })} 个百分点`)
/** 相对变化：发布前转化率为 0 时算不出来，写明原因而不是 0。 */
export const relativeText = (value: number | null | undefined): string =>
  value === null || value === undefined ? `${NONE_TEXT}（发布前转化率为零或缺失，无法计算相对变化）` : formatPercent(value, { digits: 2, sign: true })

// ---- 写入结果 ----

/** 写入受理后的提示：成功只代表“已登记”，没能入队要明说（写入记录已标失败，可以重新提交）。 */
export function writeResultNote(result: Pick<AplusWriteResult, 'queued'>): { type: 'success' | 'warning'; text: string } {
  return result.queued ? { type: 'success', text: '已登记，稍后在写入记录里看结果' } : { type: 'warning', text: '已登记，但没能进入任务队列，写入记录里已标为失败；队列恢复后可以重新提交' }
}

/** 写入入口不可用的原因（权限、连接、开关）；可用返回 null。 */
export function writeBlockOf(write: AplusWriteStatus | undefined, permitted: boolean): { reason: string; remedyPath: string | null } | null {
  if (!permitted) return { reason: '无权限：写入 A+ 内容需要“A+ 内容写入”权限（aplus.write），请联系企业管理员开通', remedyPath: null }
  if (!write) return { reason: '正在读取写入开关状态', remedyPath: null }
  if (write.allowed) return null
  return { reason: write.reason ?? '写入暂时不可用', remedyPath: write.remedyPath }
}

// ---- 编辑器本地校验 ----

/** 提交前的本地校验：店铺、名称、模块内容（aplusModuleIssues）；逐条返回中文问题，空数组表示通过。 */
export function editorIssues(input: { storeId: string | undefined; name: string; modules: readonly AplusFormModule[]; needStore: boolean }): string[] {
  const issues: string[] = []
  if (input.needStore && !input.storeId) issues.push('请先选择店铺')
  const name = input.name.trim()
  if (!name) issues.push('请填写内容名称')
  else if (name.length > APLUS_LIMITS.nameMax) issues.push(`名称不能超过 ${APLUS_LIMITS.nameMax} 个字符，现在有 ${name.length} 个`)
  issues.push(...aplusModuleIssues(input.modules).map(issue => issue.message))
  return issues
}

// ---- 关联 ASIN ----

export interface AsinInput {
  asins: string[]
  duplicates: number
  issues: string[]
}

/** 解析输入的 ASIN：空格、逗号、分号、换行分隔；转大写、去重；10 位字母或数字；一次不超过上限。 */
export function parseAsinInput(text: string): AsinInput {
  const tokens = text
    .split(/[\s,，;；、]+/)
    .map(item => item.trim().toUpperCase())
    .filter(Boolean)
  const unique = [...new Set(tokens)]
  const bad = unique.filter(item => !APLUS_ASIN_PATTERN.test(item))
  const issues: string[] = []
  if (bad.length > 0) issues.push(`不是有效的 ASIN（要 10 位字母或数字）：${bad.slice(0, 5).join('、')}${bad.length > 5 ? ` 等 ${bad.length} 个` : ''}`)
  if (unique.length > APLUS_LIMITS.asinsPerRequestMax) issues.push(`一次最多关联 ${APLUS_LIMITS.asinsPerRequestMax} 个 ASIN，现在有 ${unique.length} 个`)
  return { asins: unique.filter(item => APLUS_ASIN_PATTERN.test(item)), duplicates: tokens.length - unique.length, issues }
}

// ---- 图片 ----

/** 选图片文件前的本地校验：只收 JPG 与 PNG，不超过上限。返回问题文字，没有问题返回 null。 */
export function imageFileIssue(file: { name: string; type: string; size: number }): string | null {
  if (!(APLUS_UPLOAD_TYPES as readonly string[]).includes(file.type)) return `“${file.name}”不是 JPG 或 PNG 图片，不能上传`
  if (file.size <= 0) return `“${file.name}”是空文件`
  if (file.size > APLUS_LIMITS.imageMaxBytes) return `“${file.name}”有 ${formatBytes(file.size)}，超过 ${formatBytes(APLUS_LIMITS.imageMaxBytes)} 的上限`
  return null
}

/** 图库里的图能不能放进某类模块：成功上传且拿到上传编号，原图宽高都不小于模块要求。 */
export function imageOptionState(upload: Pick<AplusUploadRow, 'status' | 'uploadDestinationId' | 'width' | 'height'>, type: AplusModuleType): { usable: boolean; reason: string | null } {
  if (upload.status !== 'SUCCEEDED' || !upload.uploadDestinationId) return { usable: false, reason: '还没有上传成功' }
  const size = APLUS_MODULE_DEFS[type].imageSize
  if (size && (upload.width < size.width || upload.height < size.height)) return { usable: false, reason: `尺寸不够：至少需要 ${size.width}×${size.height}，这张只有 ${upload.width}×${upload.height}` }
  return { usable: true, reason: null }
}

/** 接口原样返回的模块里取类型名（预览不支持的模块要显示它）。 */
export function rawModuleType(raw: unknown): string {
  const type = raw && typeof raw === 'object' ? (raw as { contentModuleType?: unknown }).contentModuleType : undefined
  return typeof type === 'string' && type ? type : '未知'
}
