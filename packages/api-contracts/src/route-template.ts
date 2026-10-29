// 前端性能埋点的指标名与路径模板归一（不依赖 zod）。
// 前端首屏要用 `normalizeRouteTemplate`；放在带 zod 校验的 telemetry.ts 里会把 zod 整个带进首屏（X-01），所以单独成文件。
// 这个文件不要引入 zod，也不要引入会引入 zod 的文件。

/** FCP 首次内容绘制、LCP 最大内容渲染、TTI 首次可交互（外壳可操作）、API 接口耗时。 */
export const WEB_VITAL_NAMES = ['FCP', 'LCP', 'TTI', 'API'] as const
export type WebVitalName = (typeof WEB_VITAL_NAMES)[number]

/**
 * 路径模板归一：去掉查询串，把形似具体编号的路径段（纯数字，或长度不少于 8 且含数字）替换为 `:id`。
 * 前端上报前与服务端入库前各做一次，防止具体编号进入指标、造成标签数量失控。
 */
export function normalizeRouteTemplate(route: string): string {
  return route
    .split('?')[0]
    .split('#')[0]
    .split('/')
    .map(segment => (/^\d+$/.test(segment) || (segment.length >= 8 && /\d/.test(segment)) ? ':id' : segment))
    .join('/')
}
