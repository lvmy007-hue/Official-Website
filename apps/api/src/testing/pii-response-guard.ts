import { isGuardAllowedPath, scanResponse } from '@nova/api-contracts'

// 个人信息响应守卫（P6-14）：测试工具 call 的每一个响应都过一遍，除了 POST /pii/reveal 之外，
// 响应里不许出现个人信息字段名（买家姓名、邮箱、电话、地址、备注、密文），也不许出现测试里登记过的明文哨兵。
// 这样“其他接口只返回掩码”不靠逐个接口的测试记得去断言，而是对全部既有与未来的测试自动生效。

const sentinels = new Set<string>()

/** 登记一段测试里造数用的明文（例如买家姓名）：之后任何接口响应里出现它都算泄露。 */
export function registerPiiSentinel(...values: string[]): void {
  for (const value of values) if (value) sentinels.add(value)
}

export function clearPiiSentinels(): void {
  sentinels.clear()
}

export class PiiLeakError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly findings: ReadonlyArray<{ where: string; what: string }>,
  ) {
    super(`个人信息泄露：${method} ${path} 的响应里出现 ${findings.map(item => `${item.what}（${item.where}）`).join('、')}`)
  }
}

/** 检查一个响应；查看明文的统一出口例外。有问题抛 PiiLeakError。 */
export function assertNoPiiLeak(method: string, path: string, body: unknown): void {
  if (isGuardAllowedPath(path)) return
  const findings = scanResponse(body, [...sentinels])
  if (findings.length > 0) throw new PiiLeakError(method, path, findings)
}
