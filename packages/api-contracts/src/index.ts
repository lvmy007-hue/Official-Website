import { z } from 'zod'
export const LoginInputSchema = z.object({ email: z.string().email(), password: z.string().min(1), tenantId: z.string().optional() })
export const ContactRequestSchema = z.object({ name: z.string().min(1), company: z.string().min(1), email: z.string().email(), message: z.string().min(1).max(5000) })
export type ContactRequestInput = z.infer<typeof ContactRequestSchema>
export const OAuthStartSchema = z.object({ legalEntityId: z.string().min(1), region: z.string().min(1), returnUrl: z.string().url() })
export const SyncCreateSchema = z.object({ type: z.enum(['ORDERS', 'INVENTORY', 'FINANCE', 'ADS']), connectionId: z.string().min(1) })
export const ReportCreateSchema = z.object({ profileId: z.string().min(1), reportType: z.string().min(1), from: z.string(), to: z.string() })
export const FbaDataDomainSchema = z.enum(['CATALOG', 'LISTINGS', 'ORDERS', 'INVENTORY', 'INBOUND', 'FINANCES', 'REPORTS', 'RETURNS', 'ADS'])
export const FbaSyncCreateSchema = z.object({ type: FbaDataDomainSchema, connectionId: z.string().min(1), marketplaceId: z.string().default('ATVPDKIKX0DER') })
export const FbaListQuerySchema = z.object({ q: z.string().optional(), status: z.string().optional(), marketplaceId: z.string().default('ATVPDKIKX0DER'), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) })
export const FbaInboundPlanCreateSchema = z.object({ name: z.string().min(1).max(120), marketplaceId: z.string().default('ATVPDKIKX0DER'), sourceAddress: z.string().min(1), items: z.array(z.object({ sellerSku: z.string().min(1), asin: z.string().min(1), quantity: z.number().int().positive(), prepOwner: z.string().optional(), labelOwner: z.string().optional() })).min(1) })
export const FbaReportCreateSchema = z.object({ reportType: z.string().min(1).max(120), marketplaceId: z.string().default('ATVPDKIKX0DER'), from: z.string().optional(), to: z.string().optional() })
export type LoginInput = z.infer<typeof LoginInputSchema>
export type FbaDataDomain = z.infer<typeof FbaDataDomainSchema>
export type FbaSyncCreateInput = z.infer<typeof FbaSyncCreateSchema>
export type FbaListQuery = z.infer<typeof FbaListQuerySchema>
export type FbaInboundPlanCreateInput = z.infer<typeof FbaInboundPlanCreateSchema>
export type FbaReportCreateInput = z.infer<typeof FbaReportCreateSchema>
