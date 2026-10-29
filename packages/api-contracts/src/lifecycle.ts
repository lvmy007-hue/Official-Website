import { z } from 'zod'

// 租户注册与生命周期的契约（P1-19，12 章 12.7）：平台运营后台、一次性邀请、初始化向导、限时支持访问、配额。

// ---------------------------------------------------------------- 生命周期状态

export const TENANT_LIFECYCLE_STATUSES = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'CLOSING', 'CLOSED'] as const
export type TenantLifecycleStatus = (typeof TENANT_LIFECYCLE_STATUSES)[number]

export const TENANT_STATUS_LABELS: Record<TenantLifecycleStatus, string> = {
  TRIAL: '试用',
  ACTIVE: '正常',
  SUSPENDED: '暂停',
  DEACTIVATED: '停用',
  CLOSING: '注销中',
  CLOSED: '已注销',
}

/** 可以正常读写、同步的状态 */
export const WORKING_STATUSES: readonly TenantLifecycleStatus[] = ['TRIAL', 'ACTIVE']
/** 可以登录、只读使用的状态（暂停：只读，停止同步） */
export const READABLE_STATUSES: readonly TenantLifecycleStatus[] = ['TRIAL', 'ACTIVE', 'SUSPENDED']

/** 状态流转：key 状态可以转到 value 里的状态（注销只能从停用或暂停发起，注销是不可逆的）。 */
export const LIFECYCLE_TRANSITIONS: Record<TenantLifecycleStatus, readonly TenantLifecycleStatus[]> = {
  TRIAL: ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'],
  ACTIVE: ['SUSPENDED', 'DEACTIVATED'],
  SUSPENDED: ['ACTIVE', 'DEACTIVATED', 'CLOSING'],
  DEACTIVATED: ['ACTIVE', 'CLOSING'],
  CLOSING: ['CLOSED'],
  CLOSED: [],
}

export const canTransition = (from: TenantLifecycleStatus, to: TenantLifecycleStatus) => LIFECYCLE_TRANSITIONS[from].includes(to)

/** 邀请链接有效期（小时）：12.7 规定 72 小时，只能使用一次。 */
export const INVITATION_TTL_HOURS = 72
/** 企业授权支持访问的最长时长（小时） */
export const SUPPORT_ACCESS_MAX_HOURS = 168
/** 停用后数据默认保留天数；注销导出包保留天数 */
export const DEFAULT_RETENTION_DAYS = 90
export const CLOSE_EXPORT_RETENTION_DAYS = 30
/** 注销后审计记录保留天数（合规）：到期由后台清理 */
export const CLOSED_AUDIT_RETENTION_DAYS = 730

// ---------------------------------------------------------------- 密码强度（防滥用）

const COMMON_PASSWORDS = new Set(['password1234', 'qwerty123456', '123456789012', 'admin1234567', 'letmein12345', 'welcome12345', 'abcdefg12345', 'iloveyou1234', 'password!234', 'passw0rd1234'])

/** 密码强度：至少 12 位；大写、小写、数字、符号至少含三类；不得是常见弱密码，也不得包含邮箱名。返回问题列表，空表示通过。 */
export function passwordProblems(password: string, context: { email?: string } = {}): string[] {
  const problems: string[] = []
  if (password.length < 12) problems.push('密码至少 12 位')
  if (password.length > 128) problems.push('密码最长 128 位')
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(password)).length
  if (classes < 3) problems.push('密码需包含大写字母、小写字母、数字、符号中的至少三类')
  if (COMMON_PASSWORDS.has(password.toLowerCase())) problems.push('密码过于常见')
  const local = context.email?.split('@')[0]?.toLowerCase()
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) problems.push('密码不能包含邮箱名')
  if (/(.)\1{5,}/.test(password)) problems.push('密码不能含有连续重复的字符')
  return problems
}

export const PasswordSchema = z
  .string()
  .max(256)
  .superRefine((value, ctx) => {
    for (const message of passwordProblems(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message })
  })

// ---------------------------------------------------------------- 平台运营后台

const EmailSchema = z.string().trim().toLowerCase().email().max(254)
export const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{2,62}$/, '标识只能含小写字母、数字、连字符，3 至 63 位')
export const TimezoneSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .refine(value => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value })
      return true
    } catch {
      return false
    }
  }, '时区名称不正确')
export const PlatformReasonSchema = z.string().trim().min(5, '请填写原因（至少 5 个字）').max(500)

export const PlatformLoginBodySchema = z.object({ email: EmailSchema, password: z.string().min(1).max(256) })
export type PlatformLoginBody = z.infer<typeof PlatformLoginBodySchema>
export const PlatformMfaBodySchema = z.object({
  challengeToken: z.string().min(20).max(2000),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, '请输入 6 位动态验证码'),
})
export type PlatformMfaBody = z.infer<typeof PlatformMfaBodySchema>

export const QUOTA_KEYS = ['stores', 'members', 'backfillDays'] as const
export type QuotaKey = (typeof QUOTA_KEYS)[number]
export const QUOTA_LABELS: Record<QuotaKey, string> = { stores: '店铺数', members: '成员数', backfillDays: '历史回补天数' }
/** 新企业默认配额（平台开通时可按报价修改） */
export const DEFAULT_QUOTAS: Record<QuotaKey, number> = { stores: 5, members: 10, backfillDays: 730 }
export const QuotaValuesSchema = z.object({
  stores: z.number().int().min(0).max(1000),
  members: z.number().int().min(0).max(10000),
  backfillDays: z.number().int().min(0).max(730),
})
export type QuotaValues = z.infer<typeof QuotaValuesSchema>

export const PlatformTenantListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(TENANT_LIFECYCLE_STATUSES).optional(),
  cursor: z.string().max(200).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type PlatformTenantListQuery = z.infer<typeof PlatformTenantListQuerySchema>

export const PlatformTenantCreateBodySchema = z.object({
  name: z.string().trim().min(2).max(160),
  slug: SlugSchema,
  adminEmail: EmailSchema,
  trial: z.boolean().default(false),
  localTimezone: TimezoneSchema.default('Asia/Shanghai'),
  retentionDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION_DAYS),
  quotas: QuotaValuesSchema.default(DEFAULT_QUOTAS),
})
export type PlatformTenantCreateBody = z.infer<typeof PlatformTenantCreateBodySchema>

export const TenantInviteBodySchema = z.object({ email: EmailSchema.optional() })
export type TenantInviteBody = z.infer<typeof TenantInviteBodySchema>
export const PlatformReasonBodySchema = z.object({ reason: PlatformReasonSchema })
export type PlatformReasonBody = z.infer<typeof PlatformReasonBodySchema>
/** 停用：可同时调整数据保留天数 */
export const TenantDeactivateBodySchema = z.object({ reason: PlatformReasonSchema, retentionDays: z.number().int().min(1).max(3650).optional() })
export type TenantDeactivateBody = z.infer<typeof TenantDeactivateBodySchema>
/** 注销：必须重新输入企业标识确认，且需要再次验证身份（动态验证码） */
export const TenantCloseBodySchema = z.object({
  reason: PlatformReasonSchema,
  confirmSlug: SlugSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, '请输入 6 位动态验证码'),
})
export type TenantCloseBody = z.infer<typeof TenantCloseBodySchema>
export const TenantQuotaBodySchema = z.object({ quotas: QuotaValuesSchema.partial().refine(value => Object.keys(value).length > 0, '至少修改一项配额'), reason: PlatformReasonSchema })
export type TenantQuotaBody = z.infer<typeof TenantQuotaBodySchema>

// ---------------------------------------------------------------- 支持访问

/** 企业所有者授权：时长与原因 */
export const SupportAccessGrantBodySchema = z.object({ hours: z.number().int().min(1).max(SUPPORT_ACCESS_MAX_HOURS), reason: PlatformReasonSchema })
export type SupportAccessGrantBody = z.infer<typeof SupportAccessGrantBodySchema>
/** 平台支持人员领取（或续发会话令牌）：必须有企业已授权的记录；同时再次验证动态验证码 */
export const SupportAccessRequestBodySchema = z.object({
  accessId: z.string().min(1).max(64),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, '请输入 6 位动态验证码'),
})
export type SupportAccessRequestBody = z.infer<typeof SupportAccessRequestBodySchema>
/** 支持访问会话令牌有效期（分钟） */
export const SUPPORT_TOKEN_MINUTES = 15

// ---------------------------------------------------------------- 邀请激活

export const InviteAcceptBodySchema = z.object({ password: PasswordSchema, displayName: z.string().trim().min(1).max(80) })
export type InviteAcceptBody = z.infer<typeof InviteAcceptBodySchema>

// ---------------------------------------------------------------- 初始化向导（8 步）

export const ONBOARDING_STEPS = [
  { key: 'PROFILE', no: 1, title: '企业资料', required: true, hint: '数据口径时区默认美国太平洋时区，显示币种默认美元；另设企业本地时区，用于日报发送时间' },
  { key: 'ENTITIES', no: 2, title: '法律主体', required: true, hint: '至少登记一个法律主体，店铺挂在主体名下' },
  { key: 'SELLER_AUTH', no: 3, title: '卖家接口授权', required: true, hint: '授权亚马逊美国站店铺后才能同步订单、库存与财务' },
  { key: 'ADS_AUTH', no: 4, title: '广告接口授权', required: false, hint: '授权广告账户，并把广告账户绑定到店铺' },
  { key: 'SYNC_SCOPE', no: 5, title: '同步范围', required: true, hint: '选择需要同步的数据域与历史回补时长' },
  { key: 'FX_COST', no: 6, title: '汇率与成本口径', required: true, hint: '汇率每日抓取、以美元为基准；选择成本计价方式' },
  { key: 'MEMBERS', no: 7, title: '邀请成员', required: false, hint: '邀请成员并分配角色与数据范围' },
  { key: 'WRITE_SWITCHES', no: 8, title: '写入开关', required: true, hint: '默认全部只读，需要写入亚马逊时再单独开启' },
] as const
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number]['key']
export const ONBOARDING_STEP_KEYS = ONBOARDING_STEPS.map(step => step.key) as unknown as readonly [OnboardingStepKey, ...OnboardingStepKey[]]
export const ONBOARDING_STEP_STATES = ['PENDING', 'COMPLETED', 'SKIPPED'] as const
export type OnboardingStepState = (typeof ONBOARDING_STEP_STATES)[number]

export const SYNC_SCOPE_DOMAINS = ['ORDERS', 'INVENTORY', 'FINANCE', 'ADS'] as const
export const SYNC_SCOPE_LABELS: Record<(typeof SYNC_SCOPE_DOMAINS)[number], string> = { ORDERS: '订单', INVENTORY: '库存', FINANCE: '财务', ADS: '广告' }

/** 历史回补分段上限（天）：财务交易接口每段最多 180 天，广告报表每段最多 120 天（12.7 第 5 条）。订单按 90 天一段。 */
export const BACKFILL_SEGMENT_DAYS = { FINANCE: 180, ADS: 120, ORDERS: 90 } as const

export const ProfileDataSchema = z.object({
  name: z.string().trim().min(2).max(160),
  timezone: TimezoneSchema,
  localTimezone: TimezoneSchema,
  defaultCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, '币种应为三位字母代码'),
})
export const SyncScopeDataSchema = z.object({
  domains: z.array(z.enum(SYNC_SCOPE_DOMAINS)).min(1, '至少选择一个数据域').max(4),
  backfillDays: z.number().int().min(7).max(730),
})
export const FxCostDataSchema = z.object({ costMethod: z.enum(['WEIGHTED_AVERAGE', 'FIFO']), fxPolicy: z.enum(['AUTO_DAILY', 'AUTO_WITH_MANUAL_OVERRIDE']) })
export const MemberInviteItemSchema = z.object({
  email: EmailSchema,
  roleId: z.enum(['preset-admin', 'preset-ops', 'preset-ads', 'preset-finance', 'preset-supply', 'preset-readonly']),
  /** 空数组表示全部店铺；否则只授权所列店铺 */
  sellerAccountIds: z.array(z.string().min(1).max(64)).max(200).default([]),
})
export const MembersDataSchema = z.object({ invites: z.array(MemberInviteItemSchema).min(1).max(20) })
export type MemberInviteItem = z.infer<typeof MemberInviteItemSchema>

/** PATCH /onboarding：保存或完成某一步。version 是向导当前版本号（乐观锁）。 */
export const OnboardingStepBodySchema = z.object({
  step: z.enum(ONBOARDING_STEP_KEYS),
  action: z.enum(['SAVE', 'COMPLETE', 'SKIP']),
  data: z.unknown().optional(),
  version: z.number().int().min(1),
})
export type OnboardingStepBody = z.infer<typeof OnboardingStepBodySchema>

// ---------------------------------------------------------------- 历史回补分段（纯函数）

export interface BackfillSegment {
  from: string
  to: string
}

/**
 * 把 [from, to) 切成每段不超过 maxDays 天的区间（按 UTC 日切）。
 * 从最近往回切：最近的一段最先执行，用户最先看到近期数据。返回顺序即建议的执行顺序（由近及远）。
 */
export function planBackfillSegments(to: Date, totalDays: number, maxDays: number): BackfillSegment[] {
  if (totalDays <= 0 || maxDays <= 0) return []
  const segments: BackfillSegment[] = []
  const end = to.getTime()
  const start = end - totalDays * 86_400_000
  for (let segmentEnd = end; segmentEnd > start; segmentEnd -= maxDays * 86_400_000) {
    const segmentStart = Math.max(start, segmentEnd - maxDays * 86_400_000)
    segments.push({ from: new Date(segmentStart).toISOString(), to: new Date(segmentEnd).toISOString() })
  }
  return segments
}

// ---------------------------------------------------------------- 注销流程（Tenant.closeStateJson）

/** 注销的步骤（按顺序执行，每步幂等，失败后可从失败处续跑） */
export const CLOSE_STEPS = [
  { key: 'EXPORT', title: '导出企业数据' },
  { key: 'REVOKE_AUTH', title: '撤销接口授权' },
  { key: 'DELETE_TOKENS', title: '删除授权令牌' },
  { key: 'DELETE_PII', title: '删除买家个人信息' },
  { key: 'DELETE_DATA', title: '删除业务数据与文件' },
  { key: 'PROOF', title: '生成删除证明' },
] as const
export type CloseStepKey = (typeof CLOSE_STEPS)[number]['key']
export type CloseStepStatus = 'PENDING' | 'DONE' | 'FAILED'

export interface CloseStepRecord {
  state: CloseStepStatus
  finishedAt?: string
  /** 本步结果的统计（删除的行数、文件数等），不含任何业务内容 */
  detail?: Record<string, unknown>
  error?: string
}

export interface CloseState {
  /** 第几次执行（失败后续跑 +1） */
  runs: number
  startedAt: string
  requestedBy: string
  steps: Record<CloseStepKey, CloseStepRecord>
  /** 导出包：对象存储路径、大小、校验值、行数、到期时间（保留 30 天） */
  export?: { key: string; bytes: number; sha256: string; rows: number; expiresAt: string }
  /** 删除证明：各表删除行数与文件数、完成时间；证明本身也写入生命周期事件 */
  proof?: { completedAt: string; tables: Record<string, number>; files: number; authorizationsRevokedLocally: number }
  failed?: boolean
  /** 到期清理的完成时间：导出包（30 天）与审计（730 天） */
  purged?: { export?: string; audit?: string }
}

export const initialCloseState = (requestedBy: string, now = new Date()): CloseState => ({
  runs: 1,
  startedAt: now.toISOString(),
  requestedBy,
  steps: Object.fromEntries(CLOSE_STEPS.map(step => [step.key, { state: 'PENDING' as const }])) as Record<CloseStepKey, CloseStepRecord>,
})
