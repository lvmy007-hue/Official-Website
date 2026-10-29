import { z } from 'zod'

// 汇率契约（P1-28，09 章 9.14）：以美元为基准，rate 为 1 美元折合的外币金额。

export const FX_BASE_CURRENCY = 'USD'
export const FX_PROVIDERS = {
  /** 主源：Frankfurter 混合汇率（决策 D-01 选 A：条款明确可商用与缓存） */
  FRANKFURTER_BLENDED: { label: 'Frankfurter 混合汇率', template: 'https://api.frankfurter.dev/v2/rate/{base}/{quote}' },
  /** 备源：Frankfurter 的欧洲央行通道（与混合汇率不是同一个数据供应商） */
  FRANKFURTER_ECB: { label: 'Frankfurter · 欧洲央行', template: 'https://api.frankfurter.dev/v2/providers/ecb/rate/{base}/{quote}' },
} as const
export type FxProvider = keyof typeof FX_PROVIDERS
export const FX_PROVIDER_KEYS = Object.keys(FX_PROVIDERS) as [FxProvider, ...FxProvider[]]
export const FX_ROLES = ['PRIMARY', 'BACKUP'] as const
export type FxRole = (typeof FX_ROLES)[number]
/** 来源地址只允许这些主机，防止把获取任务变成向任意地址发请求（SSRF） */
export const FX_ALLOWED_HOSTS: readonly string[] = ['api.frankfurter.dev', 'api.frankfurter.app']
/** 手工覆盖的来源标记（FxRate.source） */
export const FX_MANUAL_SOURCE = 'MANUAL'
/** 汇率曲线默认与最长展示天数 */
export const FX_CURVE_DEFAULT_DAYS = 90
export const FX_CURVE_MAX_DAYS = 730
/** 当天缺失时最多向前取多少天的汇率（超出视为缺失，不再沿用） */
export const FX_FALLBACK_MAX_DAYS = 10

export const CurrencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, '币种应为 3 位字母代码')
  .refine(value => value !== FX_BASE_CURRENCY, '美元是基准币种，不需要汇率')

const dateText = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  }, '日期不存在')

export const FxQuerySchema = z.object({
  quote: CurrencyCodeSchema.optional(),
  days: z.coerce.number().int().min(7).max(FX_CURVE_MAX_DAYS).default(FX_CURVE_DEFAULT_DAYS),
})

/** POST /settings/fx：手工覆盖某一天的汇率。必须写原因；日期不能晚于今天。 */
export const FxOverrideBodySchema = z.object({
  kind: z.literal('override'),
  quoteCurrency: CurrencyCodeSchema,
  rateDate: dateText,
  rate: z.coerce
    .number()
    .positive('汇率必须大于 0')
    .max(1_000_000, '汇率数值过大')
    .refine(value => Number.isFinite(value) && Math.abs(Number(value.toFixed(8)) - value) < 1e-12, '汇率最多 8 位小数'),
  reason: z.string().trim().min(2, '请填写覆盖原因').max(500),
})

/** POST /settings/fx：选择汇率来源。主源与备源不能相同；来源地址留空则用提供方的默认地址。 */
export const FxSourceBodySchema = z.object({
  kind: z.literal('source'),
  primary: z.object({ provider: z.enum(FX_PROVIDER_KEYS), pathTemplate: z.string().trim().url().max(300).optional() }),
  backup: z.object({ provider: z.enum(FX_PROVIDER_KEYS), pathTemplate: z.string().trim().url().max(300).optional() }),
  reason: z.string().trim().min(2, '请填写调整原因').max(500),
})

export const FxWriteBodySchema = z
  .discriminatedUnion('kind', [FxOverrideBodySchema, FxSourceBodySchema])
  .refine(value => value.kind !== 'source' || value.primary.provider !== value.backup.provider, { message: '主源与备源不能选同一个来源', path: ['backup'] })

/** 附加币种（采购或费用用到的、不是人民币的币种）：POST /settings/fx 之外的小接口，使用同一权限 */
export const FxCurrenciesBodySchema = z.object({ currencies: z.array(CurrencyCodeSchema).max(12), reason: z.string().trim().min(2).max(500) })

/** 校验来源地址：必须是 https、主机在白名单、模板里含 {base} 与 {quote}。返回问题说明或 null。 */
export function fxTemplateProblem(template: string): string | null {
  let url: URL
  try {
    url = new URL(template.replace('{base}', 'USD').replace('{quote}', 'CNY').replace('{date}', '2026-01-01'))
  } catch {
    return '来源地址格式不正确'
  }
  if (url.protocol !== 'https:') return '来源地址必须使用 https'
  if (!FX_ALLOWED_HOSTS.includes(url.hostname)) return `来源地址的主机必须是 ${FX_ALLOWED_HOSTS.join(' 或 ')}`
  if (!template.includes('{base}') || !template.includes('{quote}')) return '来源地址必须包含 {base} 与 {quote}'
  return null
}

/** 汇率行（只含选取有效汇率需要的字段；日期为 YYYY-MM-DD） */
export interface FxRow {
  rateDate: string
  rate: number
  source: string
  isFallback: boolean
  isManualOverride: boolean
}

/** 同一天有多条时的取舍：手工覆盖优先，其次是当天实际获取的，最后才是沿用前一日的回退值。 */
export function pickEffectiveRate<T extends FxRow>(rows: readonly T[]): T | undefined {
  const rank = (row: FxRow) => (row.isManualOverride ? 0 : row.isFallback ? 2 : 1)
  return [...rows].sort((a, b) => rank(a) - rank(b))[0]
}

/**
 * 取某一天适用的汇率：当天没有时向前最多沿用 FX_FALLBACK_MAX_DAYS 天（周末与节假日没有牌价），超出视为缺失。
 * byDate 的键为 YYYY-MM-DD，值为该天已选定的有效汇率。
 */
export function resolveRateOn<T extends FxRow>(date: string, byDate: ReadonlyMap<string, T>, maxBackDays: number = FX_FALLBACK_MAX_DAYS): { row: T; usedDate: string; carriedForward: boolean } | null {
  const start = new Date(`${date}T00:00:00Z`)
  for (let back = 0; back <= maxBackDays; back += 1) {
    const day = new Date(start.getTime() - back * 86_400_000).toISOString().slice(0, 10)
    const row = byDate.get(day)
    if (row) return { row, usedDate: day, carriedForward: back > 0 }
  }
  return null
}

/** 默认必有的汇率币种（人民币）；附加币种存在企业设置项 fx.extraCurrencies 里。 */
export const FX_DEFAULT_CURRENCIES: readonly string[] = ['CNY']
