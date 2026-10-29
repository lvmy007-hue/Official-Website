import { describe, expect, it } from 'vitest'
import { TenantIsolationError, bindTenantContext, currentTenantId, requireTenantId, runWithTenant, runWithTenantSlot } from './context.js'
import { isTenantCacheKey, objectKeyBelongsToTenant, tenantCacheKey, tenantObjectKey } from './keys.js'

describe('租户上下文', () => {
  it('没有上下文时取不到租户；要求租户时报错', () => {
    expect(currentTenantId()).toBeUndefined()
    expect(() => requireTenantId()).toThrow(TenantIsolationError)
  })

  it('请求入口建槽，身份解析后绑定，异步链路中可读取', async () => {
    await runWithTenantSlot(async () => {
      expect(currentTenantId()).toBeUndefined()
      bindTenantContext('t1')
      await new Promise(resolve => setTimeout(resolve, 1))
      expect(currentTenantId()).toBe('t1')
    })
    expect(currentTenantId()).toBeUndefined()
  })

  it('同一请求不能切换到另一个租户；重复绑定同一个租户没问题', () => {
    runWithTenantSlot(() => {
      bindTenantContext('t1')
      expect(() => bindTenantContext('t1')).not.toThrow()
      expect(() => bindTenantContext('t2')).toThrow(/不允许切换租户/)
    })
  })

  it('没有建槽就绑定：报错，避免静默失效', () => {
    expect(() => bindTenantContext('t1')).toThrow(/租户槽/)
  })

  it('后台任务：在指定租户中运行；缺少租户编号拒绝运行', () => {
    expect(runWithTenant('t9', () => currentTenantId())).toBe('t9')
    expect(() => runWithTenant('', () => 1)).toThrow(TenantIsolationError)
  })
})

describe('缓存键与对象存储路径', () => {
  it('缓存键以租户编号开头；业务部分不得含冒号', () => {
    expect(tenantCacheKey('t1', 'permissions', 'u9')).toBe('t:t1:permissions:u9')
    expect(isTenantCacheKey('t:t1:permissions:u9', 't1')).toBe(true)
    expect(isTenantCacheKey('t:t10:permissions:u9', 't1')).toBe(false)
    expect(() => tenantCacheKey('t1', 'a:b')).toThrow(TenantIsolationError)
    expect(() => tenantCacheKey('t1')).toThrow(TenantIsolationError)
    expect(() => tenantCacheKey('t:1', 'x')).toThrow(TenantIsolationError)
  })

  it('对象路径按“租户/数据域/日期/文件名”组织', () => {
    expect(tenantObjectKey({ tenantId: 't1', domain: 'reports', date: new Date('2026-03-05T10:00:00Z'), name: 'orders.csv.gz' })).toBe('tenants/t1/reports/2026/03/05/orders.csv.gz')
  })

  it('路径各部分不得含目录穿越或分隔符', () => {
    const base = { tenantId: 't1', domain: 'reports', date: new Date('2026-03-05T10:00:00Z'), name: 'a.csv' }
    for (const bad of [{ name: '../x' }, { name: 'a/b' }, { domain: '..' }, { domain: 'a/b' }, { name: '' }, { tenantId: 't1/..' }]) {
      expect(() => tenantObjectKey({ ...base, ...bad })).toThrow(TenantIsolationError)
    }
  })

  it('校验路径属于该租户：别的租户、穿越、绝对路径一律不属于', () => {
    expect(objectKeyBelongsToTenant('tenants/t1/reports/2026/03/05/a.csv', 't1')).toBe(true)
    expect(objectKeyBelongsToTenant('tenants/t10/reports/2026/03/05/a.csv', 't1')).toBe(false)
    expect(objectKeyBelongsToTenant('tenants/t1/../t2/reports/a.csv', 't1')).toBe(false)
    expect(objectKeyBelongsToTenant('/tenants/t1/a.csv', 't1')).toBe(false)
    expect(objectKeyBelongsToTenant('tenants\\t1\\a.csv', 't1')).toBe(false)
  })
})
