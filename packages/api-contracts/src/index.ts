import { z } from 'zod'
export const LoginInputSchema = z.object({ email: z.string().email(), password: z.string().min(1), tenantId: z.string().optional() })
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
export const LegalEntityCreateSchema = z.object({ name: z.string().trim().min(2).max(200), registeredCountry: z.string().trim().min(2).max(80), registrationNo: z.string().trim().max(120).optional() })
export type LegalEntityCreateInput = z.infer<typeof LegalEntityCreateSchema>
export const OAuthStartSchema = z.object({ legalEntityId: z.string().min(1), region: z.string().min(1), returnUrl: z.string().url().optional() })
export const AdsOAuthStartSchema = z.object({})
export const SyncCreateSchema = z.object({ type: z.enum(['ORDERS', 'INVENTORY', 'FINANCE', 'FINANCES', 'INBOUND', 'RETURNS', 'ADS']), connectionId: z.string().min(1) })
export const ReportCreateSchema = z.object({ profileId: z.string().min(1), reportType: z.string().min(1), from: z.string(), to: z.string() })
export const AdsReportCreateSchema = z.object({ profileId: z.string().min(1), reportType: z.string().min(1).max(120), adProduct: z.string().default('SPONSORED_PRODUCTS'), from: z.string().optional(), to: z.string().optional() })
export const FbaDataDomainSchema = z.enum(['CATALOG', 'LISTINGS', 'ORDERS', 'INVENTORY', 'INBOUND', 'FINANCES', 'REPORTS', 'RETURNS', 'ADS'])
export const FbaSyncCreateSchema = z.object({ type: FbaDataDomainSchema, connectionId: z.string().min(1), marketplaceId: z.string().default('ATVPDKIKX0DER') })
export const FbaListQuerySchema = z.object({ q: z.string().optional(), status: z.string().optional(), marketplaceId: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) })
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
export const FbaInboundPlanCreateSchema = z.object({ name: z.string().min(1).max(120), marketplaceId: z.string().default('ATVPDKIKX0DER'), sourceAddress: AmazonSourceAddressSchema, items: z.array(z.object({ sellerSku: z.string().min(1), asin: z.string().min(1), quantity: z.number().int().positive(), prepOwner: z.string().optional(), labelOwner: z.string().optional() })).min(1) })
export const FbaReportCreateSchema = z.object({ reportType: z.string().min(1).max(120), marketplaceId: z.string().default('ATVPDKIKX0DER'), from: z.string().optional(), to: z.string().optional() })
export type LoginInput = z.infer<typeof LoginInputSchema>
export type FbaDataDomain = z.infer<typeof FbaDataDomainSchema>
export type AdsReportCreateInput = z.infer<typeof AdsReportCreateSchema>
export type FbaSyncCreateInput = z.infer<typeof FbaSyncCreateSchema>
export type FbaListQuery = z.infer<typeof FbaListQuerySchema>
export type FbaInboundPlanCreateInput = z.infer<typeof FbaInboundPlanCreateSchema>
export type FbaReportCreateInput = z.infer<typeof FbaReportCreateSchema>
