import type { AwdAddress, AwdPackageInput } from '@nova/api-contracts'
import type { JsonObject } from '../../types'

// 入库包装在“我方格式”（AwdPackageInput，前端、接口与数据库使用）与“亚马逊格式”（DistributionPackageQuantity）之间的转换。
// 预处理方与贴标方固定为卖家（01 章 1.7）：发出去的每个商品都带 prepOwner=SELF、labelOwner=SELF，没有“由亚马逊处理”的取值。

const record = (value: unknown): JsonObject => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {})
const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

type AmazonPackage = { count: number; distributionPackage: JsonObject }

export function toAmazonPackages(packages: readonly AwdPackageInput[]): AmazonPackage[] {
  return packages.map(pack => {
    const { weight, dimensions } = pack.measurements
    const contents = pack.products?.length
      ? {
          products: pack.products.map(product => ({
            sku: product.sku,
            quantity: product.quantity,
            ...(product.expiration ? { expiration: `${product.expiration}T00:00:00Z` } : {}),
            prepDetails: { prepOwner: 'SELF', labelOwner: 'SELF' },
          })),
        }
      : { packages: toAmazonPackages(pack.packages ?? []) }
    return {
      count: pack.count,
      distributionPackage: {
        type: pack.type,
        contents,
        measurements: {
          weight: { weight: weight.value, unitOfMeasurement: weight.unit },
          ...(dimensions ? { dimensions: { length: dimensions.length, width: dimensions.width, height: dimensions.height, unitOfMeasurement: dimensions.unit } } : {}),
        },
      },
    }
  })
}

export function toAmazonAddress(address: AwdAddress): JsonObject {
  const entries = Object.entries(address).filter(([, value]) => typeof value === 'string' && value.trim() !== '')
  return Object.fromEntries(entries)
}

/** 亚马逊格式 → 我方格式；解析不了的包装计入 skipped（不猜测、不补默认值）。 */
export function fromAmazonPackages(raw: unknown): { packages: AwdPackageInput[]; skipped: number } {
  let skipped = 0
  const walk = (list: unknown): AwdPackageInput[] => {
    const out: AwdPackageInput[] = []
    for (const item of Array.isArray(list) ? list : []) {
      const entry = record(item)
      const pack = record(entry.distributionPackage)
      const type = text(pack.type)
      const count = finite(entry.count)
      const weight = record(record(pack.measurements).weight)
      const weightValue = finite(weight.weight)
      const weightUnit = text(weight.unitOfMeasurement)
      if ((type !== 'CASE' && type !== 'PALLET') || count === null || count < 1 || weightValue === null || (weightUnit !== 'POUNDS' && weightUnit !== 'KILOGRAMS')) {
        skipped += 1
        continue
      }
      const contents = record(pack.contents)
      const dims = record(record(pack.measurements).dimensions)
      const dimUnit = text(dims.unitOfMeasurement)
      const length = finite(dims.length)
      const width = finite(dims.width)
      const height = finite(dims.height)
      const products = (Array.isArray(contents.products) ? contents.products : []).flatMap(product => {
        const p = record(product)
        const sku = text(p.sku)
        const quantity = finite(p.quantity)
        if (!sku || quantity === null) {
          skipped += 1
          return []
        }
        const expiration = text(p.expiration)
        return [{ sku, quantity: Math.round(quantity), ...(expiration ? { expiration: expiration.slice(0, 10) } : {}) }]
      })
      const inner = walk(contents.packages)
      out.push({
        type,
        count: Math.round(count),
        measurements: {
          weight: { value: weightValue, unit: weightUnit },
          ...(length !== null && width !== null && height !== null && (dimUnit === 'INCHES' || dimUnit === 'CENTIMETERS') ? { dimensions: { length, width, height, unit: dimUnit } } : {}),
        },
        ...(products.length ? { products } : {}),
        ...(inner.length ? { packages: inner } : {}),
      })
    }
    return out
  }
  return { packages: walk(raw), skipped }
}

/** 每个 SKU 的有效期与预处理信息（用于补进货件明细）：同一 SKU 取最早的到期日。 */
export function skuDetailsOf(raw: unknown): Map<string, { expiryDate: string | null; prep: JsonObject | null }> {
  const result = new Map<string, { expiryDate: string | null; prep: JsonObject | null }>()
  const walk = (list: unknown) => {
    for (const item of Array.isArray(list) ? list : []) {
      const contents = record(record(record(item).distributionPackage).contents)
      for (const product of Array.isArray(contents.products) ? contents.products : []) {
        const p = record(product)
        const sku = text(p.sku)
        if (!sku) continue
        const expiry = text(p.expiration)?.slice(0, 10) ?? null
        const prior = result.get(sku)
        const earliest = prior?.expiryDate && expiry ? (prior.expiryDate < expiry ? prior.expiryDate : expiry) : (prior?.expiryDate ?? expiry)
        const prep = p.prepDetails && typeof p.prepDetails === 'object' ? (p.prepDetails as JsonObject) : null
        result.set(sku, { expiryDate: earliest, prep: prep ?? prior?.prep ?? null })
      }
      walk(contents.packages)
    }
  }
  walk(raw)
  return result
}
