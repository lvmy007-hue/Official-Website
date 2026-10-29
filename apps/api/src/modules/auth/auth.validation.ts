import { LoginInputSchema } from '@nova/api-contracts'

export const REFRESH_COOKIE_NAME = 'nova_refresh_token'

export function parseLoginInput(body: unknown) {
  return LoginInputSchema.parse(body)
}

// 从 Cookie 头取出刷新令牌；没有则返回 undefined。
export function readRefreshToken(cookieHeader: string | undefined): string | undefined {
  const match = cookieHeader?.match(new RegExp(`(?:^|;\\s*)${REFRESH_COOKIE_NAME}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : undefined
}
