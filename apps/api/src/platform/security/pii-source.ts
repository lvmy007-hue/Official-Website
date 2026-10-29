import type { PiiRevealState } from '@nova/api-contracts'
import type { RequestWithContext } from '../http'

// 个人信息来源（P6-14）：订单买家信息、退货买家备注、支持案件沟通内容各有一个来源，实现这个接口。
// 来源只负责“权限与数据范围内找到这条记录并交出存储的内容”（找不到、不在范围内一律 404），
// 不解密、不写审计、不决定能不能看——这些只在 modules/pii 的统一出口里做，所以解密调用点只有一个。

/** 存储的内容：加密保存的（交给统一出口解密）或明文保存的（支持案件正文）。 */
export type PiiStored =
  { kind: 'SEALED_JSON'; ciphertext: string } | { kind: 'SEALED_TEXT'; ciphertext: string; field: string } | { kind: 'PLAIN'; values: Readonly<Record<string, string | null>> } | { kind: 'NONE' }

export interface PiiRecord {
  /** 审计里记的对象类型与编号（系统编号）。 */
  resourceType: 'Order' | 'FbaReturnCase' | 'SupportContact'
  resourceId: string
  /** 写进审计详情的定位信息（订单号、店铺编号）：绝不含个人信息内容。 */
  detail: Record<string, unknown>
  stored: PiiStored
  /** 内容在系统里保留到什么时候；没有保留期的内容为 null。 */
  retainedUntil: Date | null
  /** 没有可展示内容时给用户的说明。 */
  notes: Readonly<Record<Exclude<PiiRevealState, 'OK'>, string>>
}

export interface PiiSource {
  /** 校验该对象所属功能的读权限与数据范围，找到记录并交出存储的内容；不在范围内或不存在抛 404。 */
  open(req: RequestWithContext, objectId: string): Promise<PiiRecord>
}
