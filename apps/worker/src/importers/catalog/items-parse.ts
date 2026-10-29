import { US_MARKETPLACE } from '../../connectors/sp-api-v2'

// 商品目录响应解析（Catalog Items API v2022-04-01，I-09）：纯函数，不访问数据库与网络。
// 字段按官方模型：items[].{asin, images, productTypes, relationships, salesRanks, summaries}，每一项都是按站点分组的数组。
// 取不到的字段保持 null（不补空串、不补 0）；只取美国站的那一组（没有站点编号时取唯一的一组）。

type Loose = Record<string, unknown>
const record = (value: unknown): Loose | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** 站点分组数组里取美国站那一组；只有一组且没写站点时也取它。 */
function forMarketplace(value: unknown): Loose | null {
  const groups = list(value)
    .map(record)
    .filter((group): group is Loose => group !== null)
  return groups.find(group => group.marketplaceId === US_MARKETPLACE) ?? (groups.length === 1 && !groups[0]!.marketplaceId ? groups[0]! : null)
}

export interface ParsedRank {
  classificationId: string
  name: string
  rank: number
}

export interface ParsedCatalogItem {
  asin: string
  brand: string | null
  imageUrl: string | null
  productType: string | null
  /** 网站展示组与浏览分类的两级名称（官方只给分类的叶子名称与展示组，没有完整路径）。 */
  categoryPath: string | null
  parentAsin: string | null
  childAsins: string[]
  variationTheme: string | null
  /** 变体维度名（小写，例如 color、size）到这个商品在该维度上的取值；目录没给出的维度不出现。 */
  variantValues: Record<string, string>
  ranks: ParsedRank[]
}

/** 属性值：官方每个属性是按站点分组的数组，元素里 value 可能是文字、数字，或带单位的对象（取 value 与 unit 拼成文字）。 */
function attributeText(value: unknown): string | null {
  if (typeof value === 'string') return text(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const item = record(value)
  if (!item) return null
  const base = attributeText(item.value)
  const unit = text(item.unit)
  return base && unit ? `${base} ${unit}` : base
}

/** 取变体主题列出的那些维度的取值（美国站；该站点没有就取唯一一组）。主题没列出维度时不取（不猜）。 */
function variantValuesOf(attributes: unknown, names: readonly string[]): Record<string, string> {
  const source = record(attributes)
  const values: Record<string, string> = {}
  if (!source) return values
  for (const raw of names) {
    const name = raw.trim().toLowerCase()
    if (!name || !/^[a-z0-9_]{1,40}$/.test(name)) continue
    const groups = list(source[raw] ?? source[name])
      .map(record)
      .filter((group): group is Loose => group !== null)
    const group = groups.find(item => item.marketplace_id === US_MARKETPLACE) ?? (groups.length === 1 && !groups[0]!.marketplace_id ? groups[0]! : null)
    const found = group ? attributeText(group) : null
    if (found) values[name] = found
  }
  return values
}

function mainImage(value: unknown): string | null {
  const images = list(forMarketplace(value)?.images)
    .map(record)
    .filter((image): image is Loose => image !== null && text(image.link) !== null)
  if (images.length === 0) return null
  const area = (image: Loose) => (Number(image.width) || 0) * (Number(image.height) || 0)
  const main = images.filter(image => image.variant === 'MAIN')
  const pool = main.length > 0 ? main : images
  return text(pool.reduce((best, image) => (area(image) > area(best) ? image : best)).link)
}

function relationOf(value: unknown): { parentAsin: string | null; childAsins: string[]; variationTheme: string | null; themeAttributes: string[] } {
  const variation = list(forMarketplace(value)?.relationships)
    .map(record)
    .find(item => item?.type === 'VARIATION')
  const asins = (raw: unknown) => list(raw).flatMap(item => (typeof item === 'string' && item.trim() ? [item.trim()] : []))
  const theme = record(variation?.variationTheme)
  return {
    parentAsin: asins(variation?.parentAsins)[0] ?? null,
    childAsins: asins(variation?.childAsins),
    variationTheme: text(theme?.theme),
    themeAttributes: list(theme?.attributes).flatMap(item => (typeof item === 'string' && item.trim() ? [item.trim()] : [])),
  }
}

function ranksOf(value: unknown): ParsedRank[] {
  const group = forMarketplace(value)
  const out: ParsedRank[] = []
  for (const entry of list(group?.classificationRanks)) {
    const item = record(entry)
    const id = text(item?.classificationId)
    const rank = Number(item?.rank)
    if (id && Number.isInteger(rank) && rank > 0) out.push({ classificationId: id, name: text(item?.title) ?? id, rank })
  }
  // 展示组排名（例如 Home & Kitchen）没有分类编号，用展示组代码作为编号并加前缀避免与分类编号撞车
  for (const entry of list(group?.displayGroupRanks)) {
    const item = record(entry)
    const id = text(item?.websiteDisplayGroup)
    const rank = Number(item?.rank)
    if (id && Number.isInteger(rank) && rank > 0) out.push({ classificationId: `display:${id}`, name: text(item?.title) ?? id, rank })
  }
  return out
}

export function parseCatalogItems(body: unknown): { items: ParsedCatalogItem[]; skipped: number } {
  let skipped = 0
  const items: ParsedCatalogItem[] = []
  for (const raw of list(record(body)?.items)) {
    const item = record(raw)
    const asin = text(item?.asin)
    if (!item || !asin) {
      skipped += 1
      continue
    }
    const summary = forMarketplace(item.summaries)
    const classification = record(summary?.browseClassification)
    const path = [text(summary?.websiteDisplayGroupName), text(classification?.displayName)].filter((part): part is string => part !== null)
    const relation = relationOf(item.relationships)
    items.push({
      asin,
      brand: text(summary?.brand),
      imageUrl: mainImage(item.images),
      productType: text(forMarketplace(item.productTypes)?.productType),
      categoryPath: path.length ? [...new Set(path)].join(' > ') : null,
      parentAsin: relation.parentAsin,
      childAsins: relation.childAsins,
      variationTheme: relation.variationTheme,
      variantValues: variantValuesOf(item.attributes, relation.themeAttributes),
      ranks: ranksOf(item.salesRanks),
    })
  }
  return { items, skipped }
}
