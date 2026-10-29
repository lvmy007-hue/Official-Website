import { createHash, randomBytes } from 'node:crypto'

// 一次性邀请令牌（12.7）：随机 256 位，链接里带明文，库里只存 SHA-256 哈希。明文只在创建时返回一次。
export const generateInviteToken = () => randomBytes(32).toString('base64url')
export const hashInviteToken = (token: string) => createHash('sha256').update(token).digest('hex')
/** 令牌的合法形态（43 位 base64url）：不合法的直接按“无效”处理，不查库 */
export const isWellFormedInviteToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token)

/** 邀请链接的站点地址：APP_PUBLIC_URL；开发环境缺省本机前端地址，生产环境必须配置。 */
export function appPublicUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.APP_PUBLIC_URL?.trim().replace(/\/+$/, '')
  if (configured) return configured
  return env.APP_MODE === 'production' ? null : 'http://localhost:5173'
}

export const inviteLink = (base: string, token: string) => `${base}/invite/${token}`
