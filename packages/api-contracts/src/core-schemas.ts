import { z } from 'zod'
import { PageParamsSchema } from './query.js'
import { US_MARKETPLACE_ID } from './scope-search.js'
// 登录、商务、授权、同步、入仓计划等早期接口的输入校验（P1 阶段）。单独成文件而不放在入口文件里:
// 包声明了 sideEffects:false，这个文件的导出没人用时会整块被打包器丢掉（连同 zod 的构造调用），
// 放在入口文件里则会因为顶层的 z.object(...) 被当成有副作用而保留，白占前端首屏体积。
// 站点固定为亚马逊美国站，其他站点按 422 拒绝。
const UsMarketplaceDefault = z.literal(US_MARKETPLACE_ID, { error: '站点只支持亚马逊美国站' }).default(US_MARKETPLACE_ID)
// 长度上限防止超长输入拖慢密码校验（P1-17）；企业邮箱最长 254，密码最长 256
export const LoginInputSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256), tenantId: z.string().max(64).optional() })
export const ContactRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  company: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(200),
  message: z.string().trim().min(1).max(5000),
  phone: z.string().trim().max(40).optional(),
  topic: z.string().trim().max(40).optional(),
  storeBand: z.string().trim().max(20).optional(),
  companyWebsite: z.string().max(200).optional(),
})
export type ContactRequestInput = z.infer<typeof ContactRequestSchema>
export const CommercePlanCodeSchema = z.enum(['SINGLE_COMPANY', 'MULTI_COMPANY', 'ENTERPRISE_CUSTOM'])
export const CommerceOrderCreateSchema = z.object({
  planCode: CommercePlanCodeSchema,
  companyName: z.string().trim().min(2).max(160),
  creditCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9A-Z]{18}$/, '统一社会信用代码应为18位字母或数字'),
  contactName: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(6).max(40),
  email: z.string().trim().email().max(200),
  invoiceTitle: z.string().trim().min(2).max(160),
  taxpayerId: z.string().trim().toUpperCase().min(15).max(30),
  invoiceEmail: z.string().trim().email().max(200),
  acceptTerms: z.literal(true),
  acceptRefundPolicy: z.literal(true),
  companyWebsite: z.string().max(200).optional(),
})
export type CommerceOrderCreateInput = z.infer<typeof CommerceOrderCreateSchema>
export const CommerceRefundCreateSchema = z.object({ reason: z.string().trim().min(5).max(1000) })
export type CommerceRefundCreateInput = z.infer<typeof CommerceRefundCreateSchema>
export const CommercialPlanUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  tagline: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().min(2).max(1000).optional(),
  basePrice: z.coerce.number().positive().max(10000000).optional(),
  taxRate: z.union([z.coerce.number().min(0).max(1), z.null()]).optional(),
  legalEntityLimit: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  storeLimit: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  memberLimit: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  onlinePurchase: z.boolean().optional(),
  featured: z.boolean().optional(),
  features: z.array(z.string().trim().min(1).max(120)).min(1).max(30).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
})
export type CommercialPlanUpdateInput = z.infer<typeof CommercialPlanUpdateSchema>
export const CommerceOrderActivateSchema = z.object({
  tenantId: z.string().min(1).optional(),
  tenantSlug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{2,62}$/)
    .optional(),
})
export type CommerceOrderActivateInput = z.infer<typeof CommerceOrderActivateSchema>
export const CommerceRefundReviewSchema = z.object({ approved: z.boolean(), approvedAmount: z.coerce.number().positive().optional(), note: z.string().trim().max(1000).optional() })
export type CommerceRefundReviewInput = z.infer<typeof CommerceRefundReviewSchema>
export const LegalEntityCreateSchema = z.object({ name: z.string().trim().min(2).max(200), registeredCountry: z.string().trim().min(2).max(80), registrationNo: z.string().trim().max(120).optional() })
export type LegalEntityCreateInput = z.infer<typeof LegalEntityCreateSchema>
export const OAuthStartSchema = z.object({ legalEntityId: z.string().min(1), region: z.string().min(1), returnUrl: z.string().url().optional() })
export const AdsOAuthStartSchema = z.object({})
export const SyncCreateSchema = z.object({ type: z.enum(['ORDERS', 'INVENTORY', 'FINANCE', 'FINANCES', 'INBOUND', 'RETURNS', 'ADS']), connectionId: z.string().min(1) })
export const ReportCreateSchema = z.object({ profileId: z.string().min(1), reportType: z.string().min(1), from: z.string(), to: z.string() })
export const FbaDataDomainSchema = z.enum(['CATALOG', 'LISTINGS', 'ORDERS', 'INVENTORY', 'INBOUND', 'FINANCES', 'REPORTS', 'RETURNS', 'ADS'])
export const FbaSyncCreateSchema = z.object({ type: FbaDataDomainSchema, connectionId: z.string().min(1), marketplaceId: UsMarketplaceDefault })
export const FbaListQuerySchema = PageParamsSchema.extend({
  q: z.string().optional(),
  status: z.string().optional(),
  marketplaceId: z.literal(US_MARKETPLACE_ID, { error: '站点只支持亚马逊美国站' }).optional(),
})
export const AmazonSourceAddressSchema = z.object({
  name: z.string().trim().min(1).max(50),
  addressLine1: z.string().trim().min(1).max(180),
  addressLine2: z.string().trim().max(60).optional(),
  city: z.string().trim().min(1).max(50),
  stateOrProvinceCode: z.string().trim().min(1).max(10),
  countryCode: z.string().trim().length(2),
  postalCode: z.string().trim().min(1).max(20),
  phoneNumber: z.string().trim().min(1).max(30),
})
export const FbaInboundPlanCreateSchema = z.object({
  name: z.string().min(1).max(120),
  marketplaceId: UsMarketplaceDefault,
  sourceAddress: AmazonSourceAddressSchema,
  items: z.array(z.object({ sellerSku: z.string().min(1), asin: z.string().min(1), quantity: z.number().int().positive() })).min(1),
})
export const FbaReportCreateSchema = z.object({ reportType: z.string().min(1).max(120), marketplaceId: UsMarketplaceDefault, from: z.string().optional(), to: z.string().optional() })
export type LoginInput = z.infer<typeof LoginInputSchema>
export type FbaDataDomain = z.infer<typeof FbaDataDomainSchema>
export type FbaSyncCreateInput = z.infer<typeof FbaSyncCreateSchema>
export type FbaListQuery = z.infer<typeof FbaListQuerySchema>
export type FbaInboundPlanCreateInput = z.infer<typeof FbaInboundPlanCreateSchema>
export type FbaReportCreateInput = z.infer<typeof FbaReportCreateSchema>
