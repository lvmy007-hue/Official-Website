// 外壳偏好（P6-01，15 章第 10、11 节）：侧边导航“收藏”、界面密度，以及顶栏消息与预警未读数的响应形状。
// 本文件不依赖 zod，前端可以直接引用；请求体校验在 profile-query.ts。
//
// 规则：
// - 收藏存服务端（换设备也在），每个成员在每个企业里一份，存的是路由模板（没有动态段的页面），不存对象；
// - 服务端只校验路由模板的形状，不知道前端有哪些页面：库里出现已下线或没有权限的页面时，前端渲染时过滤，不报错；
// - 收藏上限 30 个；超过返回 422，不静默截断；读取时坏值与重复值会被丢掉（库被手工改坏也不影响页面）。

export const DENSITIES = ['COMPACT', 'STANDARD'] as const
export type Density = (typeof DENSITIES)[number]
export const DEFAULT_DENSITY: Density = 'STANDARD'
export const DENSITY_LABEL: Record<Density, string> = { COMPACT: '紧凑', STANDARD: '标准' }
export const DENSITY_HINT: Record<Density, string> = { COMPACT: '表格行高 36 像素，同屏看到更多行', STANDARD: '表格行高 40 像素，默认密度' }

export const isDensity = (value: unknown): value is Density => typeof value === 'string' && (DENSITIES as readonly string[]).includes(value)

/** 收藏数量上限（P6-01 定稿）。 */
export const FAVORITES_MAX = 30
const FAVORITE_MAX_LENGTH = 120
const FAVORITE_PATTERN = /^\/app(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/

/** 是否是合法的收藏路由模板：以 /app 开头、只含小写字母数字与连字符的静态段，不含动态参数、查询串与锚点。 */
export const isFavoriteRoute = (value: unknown): value is string => typeof value === 'string' && value.length <= FAVORITE_MAX_LENGTH && FAVORITE_PATTERN.test(value)

/** 把库里的值还原成收藏列表：不是数组按空处理；坏值与重复值丢掉，保持原有顺序，最多 FAVORITES_MAX 个。 */
export function favoritesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  for (const item of raw) {
    if (isFavoriteRoute(item) && !seen.has(item)) seen.add(item)
    if (seen.size >= FAVORITES_MAX) break
  }
  return [...seen]
}

/** 把库里的密度值还原：认不出的按标准。 */
export const densityOf = (raw: unknown): Density => (isDensity(raw) ? raw : DEFAULT_DENSITY)

/** GET /notifications/unread-count：messages 与 unreadCount 同值（不含免打扰期间收到的）；alerts 是我没读过的待处理预警数（P6-15，按人已读，受数据范围限制）；没有预警查看权限时为 null。 */
export interface UnreadCountResponse {
  /** 保留到前端全部改用 messages 为止（P6-01 前端已改用 messages，删除时点见 CR-108）。 */
  unreadCount: number
  messages: number
  alerts: number | null
}
