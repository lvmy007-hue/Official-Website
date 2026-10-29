import { z } from 'zod'
import { pageListQuery } from './query.js'
import { SHIP_FROM_STATUSES } from './ship-from.js'

// 发货地址的请求校验（P6-08）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

export const ShipFromListQuerySchema = pageListQuery({
  sortable: ['updatedAt', 'name'] as const,
  defaultSort: { field: 'updatedAt', dir: 'desc' },
  filters: { status: { type: 'enum', values: SHIP_FROM_STATUSES } },
})
export type ShipFromListQuery = z.infer<typeof ShipFromListQuerySchema>

const required = (label: string, max: number) =>
  z
    .string({ error: `请填写${label}` })
    .trim()
    .min(1, { error: `请填写${label}` })
    .max(max, { error: `${label}最多 ${max} 个字符` })

/** 国家代码两位字母（统一存大写）；州或省代码最多 10 位（统一存大写，入仓接口要的是代码不是全称）。 */
const countryCode = z
  .string({ error: '请填写国家代码' })
  .trim()
  .regex(/^[A-Za-z]{2}$/, { error: '国家代码是两位字母，例如 US' })
  .transform(value => value.toUpperCase())
const stateCode = required('州或省代码', 10).transform(value => value.toUpperCase())
const line2 = z
  .string()
  .trim()
  .max(60, { error: '地址行 2 最多 60 个字符' })
  .nullable()
  .optional()
  .transform(value => (value ? value : null))

const fields = {
  name: required('地址名称', 50),
  addressLine1: required('地址行 1', 180),
  addressLine2: line2,
  city: required('城市', 50),
  stateOrProvince: stateCode,
  postalCode: required('邮编', 20),
  countryCode,
  phone: required('电话', 30),
}

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, { error: '编号格式不正确' })

export const ShipFromCreateBodySchema = z.object({ sellerAccountId: id, ...fields, isDefault: z.boolean().default(false) }).strict()
export type ShipFromCreateBody = z.infer<typeof ShipFromCreateBodySchema>

/** 修改：带着看到的版本号（乐观锁）；至少改一项；店铺不能改（换店铺请新建）。 */
export const ShipFromUpdateBodySchema = z
  .object({
    version: z.number().int().min(1),
    name: fields.name.optional(),
    addressLine1: fields.addressLine1.optional(),
    /** 不传表示不改；传空字符串或 null 表示清空（服务里统一存成 null）。 */
    addressLine2: z.string().trim().max(60, { error: '地址行 2 最多 60 个字符' }).nullable().optional(),
    city: fields.city.optional(),
    stateOrProvince: fields.stateOrProvince.optional(),
    postalCode: fields.postalCode.optional(),
    countryCode: fields.countryCode.optional(),
    phone: fields.phone.optional(),
    status: z.enum(SHIP_FROM_STATUSES).optional(),
  })
  .strict()
export type ShipFromUpdateBody = z.infer<typeof ShipFromUpdateBodySchema>
