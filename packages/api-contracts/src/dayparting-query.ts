import { z } from 'zod'
import { DAYPARTING_GRID_SIZE, DAYPARTING_KINDS, DAYPARTING_LEVELS, DAYPARTING_MULTIPLIER, DAYPARTING_NAME_MAX, DAYPARTING_STATUSES, DAYPARTING_TARGET_LIMIT } from './dayparting'
import { gridIssue, isValidTimeZone } from './dayparting-math'

// 分时策略的请求校验（P3-12）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。
// 保存策略只改本系统里的数据（执行由 P3-17 的执行器另行提交写入）；档案、作用对象粒度与策略类型创建后不能改（要换就新建一个）。

const idText = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '编号格式不正确')
const nameText = z.string().trim().min(1, '请填写策略名称').max(DAYPARTING_NAME_MAX, `策略名称最多 ${DAYPARTING_NAME_MAX} 个字`)
const zoneText = z.string().trim().max(64).refine(isValidTimeZone, '时区名称不认识，请填写例如 America/Los_Angeles 的标准时区名')
const targetIds = z
  .array(idText)
  .min(1, '请至少选择一个作用对象')
  .max(DAYPARTING_TARGET_LIMIT, `一个策略最多 ${DAYPARTING_TARGET_LIMIT} 个作用对象`)
  .refine(ids => new Set(ids).size === ids.length, '作用对象不能重复')
const gridNumbers = z.array(z.number()).length(DAYPARTING_GRID_SIZE, `必须给满一周 ${DAYPARTING_GRID_SIZE} 个小时格`)
const baseBid = z.number().positive('基准竞价必须大于 0').max(DAYPARTING_MULTIPLIER.baseBidMax)

/** 创建：选择档案、粒度与对象，给 168 格取值。基准竞价只给竞价系数策略用；状态默认“已暂停”（先看清楚再启用）。 */
export const DaypartingBodySchema = z
  .object({
    adsProfileId: idText,
    name: nameText,
    kind: z.enum(DAYPARTING_KINDS),
    level: z.enum(DAYPARTING_LEVELS),
    targetIds,
    grid: gridNumbers,
    baseBid: baseBid.nullable().optional(),
    timezone: zoneText.optional(),
    status: z.enum(DAYPARTING_STATUSES).default('PAUSED'),
  })
  .strict()
  .superRefine((body, ctx) => {
    const issue = gridIssue(body.kind, body.grid)
    if (issue) ctx.addIssue({ code: 'custom', path: ['grid'], message: issue })
    if (body.kind === 'ON_OFF' && body.baseBid !== null && body.baseBid !== undefined) ctx.addIssue({ code: 'custom', path: ['baseBid'], message: '启停策略不需要基准竞价' })
  })
export type DaypartingBody = z.infer<typeof DaypartingBodySchema>

/** 修改：带版本号（乐观锁）；名称、对象、取值、基准竞价、时区、状态至少改一项。取值是否合法要结合策略类型，由服务再校验一次。 */
export const DaypartingUpdateBodySchema = z
  .object({
    version: z.number().int().min(1),
    name: nameText.optional(),
    targetIds: targetIds.optional(),
    grid: gridNumbers.optional(),
    baseBid: baseBid.nullable().optional(),
    timezone: zoneText.optional(),
    status: z.enum(DAYPARTING_STATUSES).optional(),
  })
  .strict()
  .refine(body => Object.keys(body).some(key => key !== 'version'), { message: '请至少修改一项内容' })
export type DaypartingUpdateBody = z.infer<typeof DaypartingUpdateBodySchema>
