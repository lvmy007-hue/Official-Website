// 路由表工具（P5-13）：从已启动的应用里读出全部已注册接口，安全扫描与渗透材料清单共用。
// 只读取框架路由栈，不依赖任何文档，新增接口自动出现在扫描里。

export type RouteEntry = { method: string; path: string }

/** 返回全部接口（含全局前缀 /api/v1），按“路径 + 方法”排序，保证清单稳定。 */
export function collectRoutes(app: { getHttpAdapter(): { getInstance(): any } }): RouteEntry[] {
  const stack: any[] = app.getHttpAdapter().getInstance()._router.stack
  const routes: RouteEntry[] = []
  for (const layer of stack) {
    if (!layer.route) continue
    for (const method of Object.keys(layer.route.methods)) routes.push({ method: method.toUpperCase(), path: layer.route.path as string })
  }
  return routes.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)))
}

export const routeKey = (route: RouteEntry) => `${route.method} ${route.path}`

/** 去掉全局前缀，用于拼接测试请求地址。 */
export const withoutPrefix = (path: string) => path.replace(/^\/api\/v1/, '')

export const hasParams = (path: string) => /:[A-Za-z]/.test(path)

/** 把路径参数全部替换成给定的值。 */
export const fillParams = (path: string, value: string) => withoutPrefix(path).replace(/:[A-Za-z]+/g, encodeURIComponent(value))

/** 递归找出响应里的所有键名（含数组里的对象）。 */
export function collectKeys(value: unknown, into = new Set<string>(), depth = 0): Set<string> {
  if (depth > 12 || value === null || typeof value !== 'object') return into
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) collectKeys(item, into, depth + 1)
    return into
  }
  for (const [key, child] of Object.entries(value)) {
    into.add(key)
    collectKeys(child, into, depth + 1)
  }
  return into
}

/**
 * 不应出现在任何响应里的键名：口令与令牌的哈希、密文、加密后的凭据、再次验证与多因素的密钥、买家信息密文。
 * 命名来自 schema.prisma 里的敏感列（passwordHash、tokenHash、refreshTokenHash、ipHash、secretCiphertext、mfaSecretCiphertext、
 * encryptedRefreshToken、stateHash、piiCiphertext、accessTokenHash），再加上常见的凭据命名，防止新字段换个名字漏出去。
 */
export const SENSITIVE_KEY = /password|passwd|ciphertext|encrypted|secret|privatekey|apikey|(token|state|ip|refreshtoken|accesstoken)hash$|^refreshtoken$|^accesstoken$/i

export function sensitiveKeys(body: unknown): string[] {
  return [...collectKeys(body)].filter(key => SENSITIVE_KEY.test(key))
}
