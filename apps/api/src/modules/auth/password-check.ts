import { compare, hash } from 'bcryptjs'

// 口令校验（P5-13，防账号枚举）：账号不存在或已停用时，也要做一次同样代价的哈希比较。
// 否则“邮箱不存在”几乎立刻返回，“邮箱存在但密码错”要多花约一次哈希的时间，攻击者靠响应耗时就能枚举出哪些邮箱是企业账号。
// 代价系数与注册时一致（12）；占位哈希只在首次需要时计算一次。
const COST = 12
let dummyHash: Promise<string> | undefined
const dummyPasswordHash = () => (dummyHash ??= hash('nova-member-dummy-password', COST))

/** 校验口令；storedHash 为空（账号不存在或不可登录）时仍做一次比较，并固定返回 false。 */
export async function verifyPassword(password: string, storedHash: string | null | undefined): Promise<boolean> {
  const matched = await compare(password, storedHash || (await dummyPasswordHash()))
  return Boolean(storedHash) && matched
}
