// 调用亚马逊接口失败时抛出的带状态码错误：任务运行时据此判断“能不能重试”，并读取 Retry-After 与限速响应头。
// 只保留状态码、来源与响应头；响应体仅在 message 中截取一小段用于排查，令牌与个人信息不会出现在这里。

export type UpstreamSource = 'lwa' | 'api' | 'download'

export class UpstreamHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Headers | undefined,
    readonly source: UpstreamSource,
  ) {
    super(message)
    this.name = 'UpstreamHttpError'
  }
}

/** 调用前后的钩子：按店铺授权做令牌桶限速，并用亚马逊返回的限速响应头校准桶。 */
export interface RequestGuard {
  /** 发请求之前：拿不到令牌会等待，等待过久抛出可重试错误。family 是接口族（如 orders、finances），不同接口族各自限速。 */
  before(family: string): Promise<void>
  after(family: string, status: number, headers: Headers): Promise<void>
}

/** 由请求路径得到接口族：取前两段，例如 /orders/v0/orders → orders/v0，/reports/2021-06-30/... → reports/2021-06-30。 */
export function apiFamilyOf(path: string): string {
  return path.split('?')[0].split('/').filter(Boolean).slice(0, 2).join('/') || 'root'
}
