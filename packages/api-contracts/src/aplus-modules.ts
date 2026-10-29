import { APLUS_LIMITS } from './aplus.js'

// A+ 内容的模块结构（P4-14）：纯函数，没有 zod，前后端共用。
// 编辑器只支持六种常用模块（见 APLUS_MODULE_TYPES）；亚马逊返回的模块转成表单模型后再转回去，必须与原结构完全一致才允许编辑，
// 否则（含不支持的模块、带文字样式的段落、不同的裁剪参数）整份内容只读，避免保存时悄悄丢掉亚马逊那边已有的内容。
// 模块字段名与图片尺寸依据官方文档整理，没有用真实店铺核对（CR-089）。

export const APLUS_MODULE_TYPES = [
  'STANDARD_TEXT',
  'STANDARD_PRODUCT_DESCRIPTION',
  'STANDARD_COMPANY_LOGO',
  'STANDARD_HEADER_IMAGE_TEXT',
  'STANDARD_SINGLE_SIDE_IMAGE',
  'STANDARD_THREE_IMAGE_TEXT',
] as const
export type AplusModuleType = (typeof APLUS_MODULE_TYPES)[number]

export interface AplusModuleDef {
  type: AplusModuleType
  label: string
  description: string
  /** 图片个数与要求的尺寸（像素）；没有图片为 null。上传的原图宽高都不能小于它，提交时按它裁剪（从左上角取）。 */
  imageSize: { width: number; height: number } | null
  imageCount: number
}

export const APLUS_MODULE_DEFS: Record<AplusModuleType, AplusModuleDef> = {
  STANDARD_TEXT: { type: 'STANDARD_TEXT', label: '纯文字', description: '标题加一段正文', imageSize: null, imageCount: 0 },
  STANDARD_PRODUCT_DESCRIPTION: { type: 'STANDARD_PRODUCT_DESCRIPTION', label: '商品描述', description: '一段商品描述正文', imageSize: null, imageCount: 0 },
  STANDARD_COMPANY_LOGO: { type: 'STANDARD_COMPANY_LOGO', label: '品牌标志', description: '一张品牌标志图', imageSize: { width: 600, height: 180 }, imageCount: 1 },
  STANDARD_HEADER_IMAGE_TEXT: { type: 'STANDARD_HEADER_IMAGE_TEXT', label: '大图文', description: '总标题，加一张大图与图下的标题和正文', imageSize: { width: 970, height: 600 }, imageCount: 1 },
  STANDARD_SINGLE_SIDE_IMAGE: { type: 'STANDARD_SINGLE_SIDE_IMAGE', label: '单图侧文', description: '一张图配文字，图在左或右', imageSize: { width: 300, height: 300 }, imageCount: 1 },
  STANDARD_THREE_IMAGE_TEXT: { type: 'STANDARD_THREE_IMAGE_TEXT', label: '三图文', description: '总标题，加三张并排的图，每张配标题和正文', imageSize: { width: 300, height: 300 }, imageCount: 3 },
}

export const APLUS_TEXT_LIMITS = { headline: 160, body: 5000, altText: 100 } as const

export interface AplusImage {
  uploadDestinationId: string
  altText: string
}
export interface AplusImageBlock {
  image: AplusImage | null
  headline: string
  body: string
}
export type AplusImagePosition = 'LEFT' | 'RIGHT'
export type AplusFormModule =
  | { type: 'STANDARD_TEXT'; headline: string; body: string }
  | { type: 'STANDARD_PRODUCT_DESCRIPTION'; body: string }
  | { type: 'STANDARD_COMPANY_LOGO'; image: AplusImage | null }
  | { type: 'STANDARD_HEADER_IMAGE_TEXT'; headline: string; block: AplusImageBlock }
  | { type: 'STANDARD_SINGLE_SIDE_IMAGE'; position: AplusImagePosition; block: AplusImageBlock }
  | { type: 'STANDARD_THREE_IMAGE_TEXT'; headline: string; blocks: [AplusImageBlock, AplusImageBlock, AplusImageBlock] }

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

const emptyBlock = (): AplusImageBlock => ({ image: null, headline: '', body: '' })
/** 新建一个空模块（编辑器“添加模块”用）。 */
export function aplusEmptyModule(type: AplusModuleType): AplusFormModule {
  switch (type) {
    case 'STANDARD_TEXT':
      return { type, headline: '', body: '' }
    case 'STANDARD_PRODUCT_DESCRIPTION':
      return { type, body: '' }
    case 'STANDARD_COMPANY_LOGO':
      return { type, image: null }
    case 'STANDARD_HEADER_IMAGE_TEXT':
      return { type, headline: '', block: emptyBlock() }
    case 'STANDARD_SINGLE_SIDE_IMAGE':
      return { type, position: 'LEFT', block: emptyBlock() }
    case 'STANDARD_THREE_IMAGE_TEXT':
      return { type, headline: '', blocks: [emptyBlock(), emptyBlock(), emptyBlock()] }
  }
}

// ---- 表单模型 → 亚马逊结构 ----

const textNode = (value: string) => ({ value })
const paragraphNode = (value: string) => ({ textList: [{ value }] })
const px = (value: number) => ({ value, units: 'pixels' })
const imageNode = (image: AplusImage, size: { width: number; height: number }) => ({
  uploadDestinationId: image.uploadDestinationId,
  imageCropSpecification: { size: { width: px(size.width), height: px(size.height) }, offset: { x: px(0), y: px(0) } },
  altText: image.altText,
})
function blockNode(block: AplusImageBlock, size: { width: number; height: number }): Json {
  const out: Json = {}
  if (block.image) out.image = imageNode(block.image, size)
  if (block.headline) out.headline = textNode(block.headline)
  if (block.body) out.body = paragraphNode(block.body)
  return out
}

/** 表单模型 → 亚马逊的模块结构（空标题与空正文不输出；图片没选时不输出图片，校验另见 aplusModuleIssues）。 */
export function aplusModuleToAmazon(module: AplusFormModule): Json {
  const size = APLUS_MODULE_DEFS[module.type].imageSize ?? { width: 0, height: 0 }
  switch (module.type) {
    case 'STANDARD_TEXT':
      return { contentModuleType: module.type, standardText: { ...(module.headline ? { headline: textNode(module.headline) } : {}), ...(module.body ? { body: paragraphNode(module.body) } : {}) } }
    case 'STANDARD_PRODUCT_DESCRIPTION':
      return { contentModuleType: module.type, standardProductDescription: module.body ? { body: paragraphNode(module.body) } : {} }
    case 'STANDARD_COMPANY_LOGO':
      return { contentModuleType: module.type, standardCompanyLogo: module.image ? { companyLogo: imageNode(module.image, size) } : {} }
    case 'STANDARD_HEADER_IMAGE_TEXT':
      return { contentModuleType: module.type, standardHeaderImageText: { ...(module.headline ? { headline: textNode(module.headline) } : {}), block: blockNode(module.block, size) } }
    case 'STANDARD_SINGLE_SIDE_IMAGE':
      return { contentModuleType: module.type, standardSingleSideImage: { imagePositionType: module.position, block: blockNode(module.block, size) } }
    case 'STANDARD_THREE_IMAGE_TEXT':
      return {
        contentModuleType: module.type,
        standardThreeImageText: {
          ...(module.headline ? { headline: textNode(module.headline) } : {}),
          block1: blockNode(module.blocks[0], size),
          block2: blockNode(module.blocks[1], size),
          block3: blockNode(module.blocks[2], size),
        },
      }
  }
}

// ---- 亚马逊结构 → 表单模型 ----

const textOf = (node: unknown): string | undefined => {
  if (node === undefined || node === null) return ''
  return isRecord(node) && typeof node.value === 'string' ? node.value : undefined
}
const paragraphOf = (node: unknown): string | undefined => {
  if (node === undefined || node === null) return ''
  if (!isRecord(node) || !Array.isArray(node.textList)) return undefined
  if (node.textList.length === 0) return ''
  if (node.textList.length !== 1) return undefined
  return textOf(node.textList[0])
}
const imageOf = (node: unknown): AplusImage | null | undefined => {
  if (node === undefined || node === null) return null
  if (!isRecord(node) || typeof node.uploadDestinationId !== 'string' || !node.uploadDestinationId) return undefined
  return { uploadDestinationId: node.uploadDestinationId, altText: typeof node.altText === 'string' ? node.altText : '' }
}
function blockOf(node: unknown): AplusImageBlock | undefined {
  if (!isRecord(node)) return node === undefined || node === null ? emptyBlock() : undefined
  const image = imageOf(node.image)
  const headline = textOf(node.headline)
  const body = paragraphOf(node.body)
  return image === undefined || headline === undefined || body === undefined ? undefined : { image, headline, body }
}

function moduleFromAmazon(raw: unknown): AplusFormModule | undefined {
  if (!isRecord(raw)) return undefined
  const type = raw.contentModuleType
  switch (type) {
    case 'STANDARD_TEXT': {
      const inner = raw.standardText
      if (!isRecord(inner)) return undefined
      const headline = textOf(inner.headline)
      const body = paragraphOf(inner.body)
      return headline === undefined || body === undefined ? undefined : { type, headline, body }
    }
    case 'STANDARD_PRODUCT_DESCRIPTION': {
      const inner = raw.standardProductDescription
      if (!isRecord(inner)) return undefined
      const body = paragraphOf(inner.body)
      return body === undefined ? undefined : { type, body }
    }
    case 'STANDARD_COMPANY_LOGO': {
      const inner = raw.standardCompanyLogo
      if (!isRecord(inner)) return undefined
      const image = imageOf(inner.companyLogo)
      return image === undefined ? undefined : { type, image }
    }
    case 'STANDARD_HEADER_IMAGE_TEXT': {
      const inner = raw.standardHeaderImageText
      if (!isRecord(inner)) return undefined
      const headline = textOf(inner.headline)
      const block = blockOf(inner.block)
      return headline === undefined || block === undefined ? undefined : { type, headline, block }
    }
    case 'STANDARD_SINGLE_SIDE_IMAGE': {
      const inner = raw.standardSingleSideImage
      if (!isRecord(inner) || (inner.imagePositionType !== 'LEFT' && inner.imagePositionType !== 'RIGHT')) return undefined
      const block = blockOf(inner.block)
      return block === undefined ? undefined : { type, position: inner.imagePositionType, block }
    }
    case 'STANDARD_THREE_IMAGE_TEXT': {
      const inner = raw.standardThreeImageText
      if (!isRecord(inner)) return undefined
      const headline = textOf(inner.headline)
      const b1 = blockOf(inner.block1)
      const b2 = blockOf(inner.block2)
      const b3 = blockOf(inner.block3)
      return headline === undefined || !b1 || !b2 || !b3 ? undefined : { type, headline, blocks: [b1, b2, b3] }
    }
    default:
      return undefined
  }
}

/** 比较前的规整：去掉空的文字样式数组、键排序。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  const out: Json = {}
  for (const key of Object.keys(value).sort()) {
    const item = value[key]
    if (key === 'decoratorSet' && Array.isArray(item) && item.length === 0) continue
    if (item !== undefined) out[key] = canonical(item)
  }
  return out
}
const sameStructure = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

export interface AplusModulesView {
  /** 转得动的模块（不可编辑时只含能预览的部分，不可编辑的模块按原顺序缺位——预览用 aplusModuleLabel 显示类型）。 */
  modules: Array<AplusFormModule | null>
  editable: boolean
  note: string | null
}

/** 亚马逊的 contentModuleList → 表单模型。任何一个模块转不了或转回去与原结构不一致，editable 为 false 并写原因。 */
export function aplusModulesFromAmazon(raw: unknown): AplusModulesView {
  const list = Array.isArray(raw) ? raw : []
  const modules: Array<AplusFormModule | null> = []
  let note: string | null = null
  list.forEach((item, index) => {
    const form = moduleFromAmazon(item)
    if (!form) {
      modules.push(null)
      const type = isRecord(item) && typeof item.contentModuleType === 'string' ? item.contentModuleType : '未知'
      note ??= `第 ${index + 1} 个模块（${aplusModuleLabel(type)}）不在编辑器支持的范围内，这份内容只能预览，请到卖家后台修改`
      return
    }
    modules.push(form)
    if (!sameStructure(item, aplusModuleToAmazon(form))) note ??= `第 ${index + 1} 个模块带有编辑器不支持的样式或裁剪设置，为避免保存时丢失，这份内容只能预览`
  })
  return {
    modules,
    editable: note === null && list.length <= APLUS_LIMITS.modulesMax,
    note: note ?? (list.length > APLUS_LIMITS.modulesMax ? `模块数超过编辑器上限 ${APLUS_LIMITS.modulesMax}，只能预览` : null),
  }
}

/** 模块类型的中文名；不在支持范围的类型显示接口里的原类型名。 */
export function aplusModuleLabel(type: string): string {
  return (APLUS_MODULE_DEFS as Record<string, AplusModuleDef | undefined>)[type]?.label ?? type
}

// ---- 校验与引用 ----

export interface AplusModuleIssue {
  /** 模块序号（从 0 起）；整份内容的问题为 -1。 */
  index: number
  field: string
  message: string
}

const blocksOf = (module: AplusFormModule): AplusImageBlock[] => {
  switch (module.type) {
    case 'STANDARD_HEADER_IMAGE_TEXT':
    case 'STANDARD_SINGLE_SIDE_IMAGE':
      return [module.block]
    case 'STANDARD_THREE_IMAGE_TEXT':
      return [...module.blocks]
    default:
      return []
  }
}
const imagesOf = (module: AplusFormModule): Array<AplusImage | null> => (module.type === 'STANDARD_COMPANY_LOGO' ? [module.image] : blocksOf(module).map(block => block.image))

/** 内容校验：模块个数、文字长度、图片必选与替代文字。返回空数组表示通过。 */
export function aplusModuleIssues(modules: readonly AplusFormModule[]): AplusModuleIssue[] {
  const issues: AplusModuleIssue[] = []
  if (modules.length === 0) issues.push({ index: -1, field: 'modules', message: '至少添加一个模块' })
  if (modules.length > APLUS_LIMITS.modulesMax) issues.push({ index: -1, field: 'modules', message: `最多 ${APLUS_LIMITS.modulesMax} 个模块` })
  modules.forEach((module, index) => {
    const label = aplusModuleLabel(module.type)
    const textFields: Array<[string, string, number, boolean]> = []
    if ('headline' in module) textFields.push(['headline', module.headline, APLUS_TEXT_LIMITS.headline, false])
    if (module.type === 'STANDARD_TEXT' || module.type === 'STANDARD_PRODUCT_DESCRIPTION') textFields.push(['body', module.body, APLUS_TEXT_LIMITS.body, true])
    blocksOf(module).forEach((block, blockIndex) => {
      textFields.push([`blocks.${blockIndex}.headline`, block.headline, APLUS_TEXT_LIMITS.headline, false])
      textFields.push([`blocks.${blockIndex}.body`, block.body, APLUS_TEXT_LIMITS.body, false])
    })
    for (const [field, value, max, required] of textFields) {
      if (required && value.trim() === '') issues.push({ index, field, message: `第 ${index + 1} 个模块（${label}）的正文不能为空` })
      if (value.length > max) issues.push({ index, field, message: `第 ${index + 1} 个模块（${label}）的文字不能超过 ${max} 个字符` })
    }
    imagesOf(module).forEach((image, imageIndex) => {
      if (!image) issues.push({ index, field: `image.${imageIndex}`, message: `第 ${index + 1} 个模块（${label}）还没有选择图片` })
      else if (image.altText.trim() === '') issues.push({ index, field: `image.${imageIndex}.altText`, message: `第 ${index + 1} 个模块（${label}）的图片需要填写替代文字` })
      else if (image.altText.length > APLUS_TEXT_LIMITS.altText) issues.push({ index, field: `image.${imageIndex}.altText`, message: `替代文字不能超过 ${APLUS_TEXT_LIMITS.altText} 个字符` })
    })
  })
  return issues
}

export interface AplusImageRef {
  uploadDestinationId: string
  /** 所在模块要求的尺寸（像素）。 */
  width: number
  height: number
}
/** 内容里用到的全部图片及其要求的尺寸（后端据此核对图片都已上传成功、尺寸够用）。 */
export function aplusImageRefs(modules: readonly AplusFormModule[]): AplusImageRef[] {
  const refs: AplusImageRef[] = []
  for (const module of modules) {
    const size = APLUS_MODULE_DEFS[module.type].imageSize
    if (!size) continue
    for (const image of imagesOf(module)) if (image) refs.push({ uploadDestinationId: image.uploadDestinationId, width: size.width, height: size.height })
  }
  return refs
}

/** 表单模型数组 → 亚马逊的 contentModuleList。 */
export const aplusModulesToAmazon = (modules: readonly AplusFormModule[]): Json[] => modules.map(aplusModuleToAmazon)

/** 请求体里的原始模块（亚马逊结构）→ 表单模型；有模块不在支持范围或与结构不一致时返回 null（接口据此拒绝）。 */
export function aplusFormModulesOf(raw: unknown): AplusFormModule[] | null {
  const view = aplusModulesFromAmazon(raw)
  if (!view.editable || view.modules.some(item => item === null)) return null
  return view.modules as AplusFormModule[]
}
