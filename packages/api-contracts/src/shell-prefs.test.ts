import { describe, expect, it } from 'vitest'
import { defaultNotifyPrefs } from './profile.js'
import { FavoritesSchema, PreferencesUpdateBodySchema } from './profile-query.js'
import { DEFAULT_DENSITY, FAVORITES_MAX, densityOf, favoritesOf, isFavoriteRoute } from './shell-prefs.js'

const routes = (count: number) => Array.from({ length: count }, (_, index) => `/app/page-${index}`)

describe('收藏路由模板的形状', () => {
  it('只接受 /app 下没有动态段的静态路径', () => {
    expect(isFavoriteRoute('/app/overview')).toBe(true)
    expect(isFavoriteRoute('/app/ads/campaigns')).toBe(true)
    expect(isFavoriteRoute('/app/inventory/:id')).toBe(false)
    expect(isFavoriteRoute('/app/overview?from=2026-01-01')).toBe(false)
    expect(isFavoriteRoute('/app/overview#top')).toBe(false)
    expect(isFavoriteRoute('/app')).toBe(false)
    expect(isFavoriteRoute('/platform/tenants')).toBe(false)
    expect(isFavoriteRoute('https://evil.example/app/overview')).toBe(false)
    expect(isFavoriteRoute('//evil.example/app/x')).toBe(false)
    expect(isFavoriteRoute('/app/Overview')).toBe(false)
    expect(isFavoriteRoute(`/app/${'a'.repeat(200)}`)).toBe(false)
    expect(isFavoriteRoute(null)).toBe(false)
    expect(isFavoriteRoute(7)).toBe(false)
  })
})

describe('库里值的还原', () => {
  it('没有保存过、不是数组：空列表', () => {
    expect(favoritesOf(undefined)).toEqual([])
    expect(favoritesOf(null)).toEqual([])
    expect(favoritesOf('/app/overview')).toEqual([])
  })
  it('坏值与重复值被丢掉，顺序保持，数量封顶', () => {
    expect(favoritesOf(['/app/b', 3, '/app/a', '/app/b', '/app/x/:id', '/app/c'])).toEqual(['/app/b', '/app/a', '/app/c'])
    expect(favoritesOf(routes(FAVORITES_MAX + 10))).toHaveLength(FAVORITES_MAX)
  })
  it('密度认不出按标准', () => {
    expect(densityOf('COMPACT')).toBe('COMPACT')
    expect(densityOf('STANDARD')).toBe('STANDARD')
    expect(densityOf('HUGE')).toBe(DEFAULT_DENSITY)
    expect(densityOf(undefined)).toBe('STANDARD')
  })
})

describe('偏好保存请求体', () => {
  it('收藏：超过上限、重复、坏地址都报错而不是静默截断', () => {
    expect(FavoritesSchema.safeParse(routes(FAVORITES_MAX)).success).toBe(true)
    expect(FavoritesSchema.safeParse(routes(FAVORITES_MAX + 1)).success).toBe(false)
    expect(FavoritesSchema.safeParse(['/app/a', '/app/a']).success).toBe(false)
    expect(FavoritesSchema.safeParse(['/app/a/:id']).success).toBe(false)
    expect(FavoritesSchema.safeParse([]).success).toBe(true)
  })
  it('通知偏好、收藏、密度各自可省略；三项都省略报错；版本必填', () => {
    expect(PreferencesUpdateBodySchema.safeParse({ version: 0, favorites: ['/app/overview'] }).success).toBe(true)
    expect(PreferencesUpdateBodySchema.safeParse({ version: 3, density: 'COMPACT' }).success).toBe(true)
    expect(PreferencesUpdateBodySchema.safeParse({ version: 1, notify: defaultNotifyPrefs() }).success).toBe(true)
    expect(PreferencesUpdateBodySchema.safeParse({ version: 1 }).success).toBe(false)
    expect(PreferencesUpdateBodySchema.safeParse({ favorites: [] }).success).toBe(false)
    expect(PreferencesUpdateBodySchema.safeParse({ version: 1, density: 'HUGE' }).success).toBe(false)
    expect(PreferencesUpdateBodySchema.safeParse({ version: -1, density: 'COMPACT' }).success).toBe(false)
  })
})
