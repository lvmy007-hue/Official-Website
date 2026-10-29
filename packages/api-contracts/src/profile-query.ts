import { z } from 'zod'
import { NOTIFY_DOMAINS, NOTIFY_SEVERITIES, isClockTime } from './profile.js'
import { DENSITIES, FAVORITES_MAX, isFavoriteRoute } from './shell-prefs.js'

// 个人账号的请求校验（P5-11）。zod 单独成文件，不进前端首屏。

const severityFlags = z.object(Object.fromEntries(NOTIFY_SEVERITIES.map(severity => [severity, z.boolean({ error: '请选择是否接收' })])) as Record<(typeof NOTIFY_SEVERITIES)[number], z.ZodBoolean>)

const clock = (label: string) => z.string().refine(isClockTime, `${label}应为 HH:MM 格式（例如 22:00）`)

/** 通知偏好：每个业务域都要给出三个级别的开关；免打扰的开始与结束不能相同。 */
export const NotifyPrefsSchema = z.object({
  domains: z.object(Object.fromEntries(NOTIFY_DOMAINS.map(domain => [domain, severityFlags])) as Record<(typeof NOTIFY_DOMAINS)[number], typeof severityFlags>),
  dnd: z
    .object({ enabled: z.boolean({ error: '请选择是否开启免打扰' }), start: clock('免打扰开始时间'), end: clock('免打扰结束时间') })
    .refine(value => value.start !== value.end, { message: '免打扰的开始与结束时间不能相同', path: ['end'] }),
})

/** 收藏列表：每项都必须是合法的路由模板，不能重复，数量不超过上限；超限报错而不是静默截断。 */
export const FavoritesSchema = z
  .array(z.string({ error: '收藏的页面地址不正确' }), { error: '收藏应为页面地址列表' })
  .max(FAVORITES_MAX, `最多收藏 ${FAVORITES_MAX} 个页面，请先取消一些再添加`)
  .superRefine((items, context) => {
    const seen = new Set<string>()
    items.forEach((item, index) => {
      if (!isFavoriteRoute(item)) context.addIssue({ code: 'custom', path: [index], message: '收藏的页面地址不正确（只能收藏没有对象参数的页面）' })
      else if (seen.has(item)) context.addIssue({ code: 'custom', path: [index], message: '收藏里有重复的页面' })
      seen.add(item)
    })
  })

/**
 * PUT /me/preferences：version 是读到的版本（还没保存过为 0）。notify、favorites、density 三项各自可省略，省略的项保持不变；
 * 出现的项整体替换（P5-11 的通知偏好原先必填，现在可省略）。三项都省略没有意义，报错。
 */
export const PreferencesUpdateBodySchema = z
  .object({
    notify: NotifyPrefsSchema.optional(),
    favorites: FavoritesSchema.optional(),
    density: z.enum(DENSITIES, { error: '密度只能是紧凑或标准' }).optional(),
    version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine(body => body.notify !== undefined || body.favorites !== undefined || body.density !== undefined, { message: '没有需要保存的内容', path: ['notify'] })
export type PreferencesUpdateBody = z.infer<typeof PreferencesUpdateBodySchema>

/** PATCH /auth/me：个人资料目前只有显示名。 */
export const ProfileUpdateBodySchema = z.object({
  displayName: z
    .string({ error: '请填写显示名' })
    .trim()
    .min(1, '请填写显示名')
    .max(60, '显示名最多 60 个字')
    .refine(value => ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127), '显示名不能包含控制字符'),
})
export type ProfileUpdateBody = z.infer<typeof ProfileUpdateBodySchema>
