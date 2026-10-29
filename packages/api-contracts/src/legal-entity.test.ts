import { describe, expect, it } from 'vitest'
import { LegalEntityListQuerySchema, LegalEntityUpdateBodySchema, entityAccessOf, entityChangesOf, entityDeactivateBlockReason, entityStatusLabel } from './index.js'

describe('法律主体契约', () => {
  it('停用前置条件：名下有店铺时给出原因，没有店铺时放行', () => {
    expect(entityDeactivateBlockReason(0)).toBeNull()
    expect(entityDeactivateBlockReason(3)).toContain('3 个店铺')
  })

  it('状态显示中文，认不出的原样返回', () => {
    expect(entityStatusLabel('ACTIVE')).toBe('使用中')
    expect(entityStatusLabel('INACTIVE')).toBe('已停用')
    expect(entityStatusLabel('LEGACY')).toBe('LEGACY')
  })

  describe('entityChangesOf', () => {
    it('只列出变化的字段，状态转成中文', () => {
      const changes = entityChangesOf(
        { name: '甲', registeredCountry: '中国', registrationNo: null, status: 'ACTIVE' },
        { name: '乙', registeredCountry: '中国', registrationNo: '9144', status: 'INACTIVE' },
      )
      expect(changes).toEqual([
        { field: 'name', label: '主体名称', before: '甲', after: '乙' },
        { field: 'registrationNo', label: '注册号', before: null, after: '9144' },
        { field: 'status', label: '状态', before: '使用中', after: '已停用' },
      ])
    })

    it('新增主体没有修改前：每个有值的字段都算一项，空的注册号不列', () => {
      const changes = entityChangesOf(null, { name: '甲', registeredCountry: '中国', registrationNo: null })
      expect(changes.map(item => item.field)).toEqual(['name', 'registeredCountry'])
      expect(changes.every(item => item.before === null)).toBe(true)
    })

    it('快照缺失或不是对象时返回空，不抛错；修改前缺字段的不比较', () => {
      expect(entityChangesOf(null, null)).toEqual([])
      expect(entityChangesOf({ name: '甲' }, 'oops')).toEqual([])
      expect(entityChangesOf({ name: '甲' }, { name: '乙', status: 'ACTIVE' })).toEqual([{ field: 'name', label: '主体名称', before: '甲', after: '乙' }])
    })
  })

  describe('entityAccessOf', () => {
    const stores = new Set(['s1', 's2'])
    it('全空授权是全部范围，优先于其他授权', () => {
      expect(
        entityAccessOf(
          [
            { legalEntityId: null, sellerAccountId: null },
            { legalEntityId: 'e1', sellerAccountId: null },
          ],
          'e1',
          stores,
        ),
      ).toEqual({ kind: 'ALL', storeIds: [] })
    })
    it('只授权了本主体是整个主体；授权别的主体与本主体无关', () => {
      expect(entityAccessOf([{ legalEntityId: 'e1', sellerAccountId: null }], 'e1', stores)).toEqual({ kind: 'ENTITY', storeIds: [] })
      expect(entityAccessOf([{ legalEntityId: 'e9', sellerAccountId: null }], 'e1', stores)).toBeNull()
    })
    it('店铺授权只算本主体名下的店铺，去重', () => {
      expect(
        entityAccessOf(
          [
            { legalEntityId: null, sellerAccountId: 's1' },
            { legalEntityId: 'e1', sellerAccountId: 's1' },
            { legalEntityId: null, sellerAccountId: 'other' },
          ],
          'e1',
          stores,
        ),
      ).toEqual({ kind: 'STORES', storeIds: ['s1'] })
      expect(entityAccessOf([{ legalEntityId: null, sellerAccountId: 'other' }], 'e1', stores)).toBeNull()
      expect(entityAccessOf([], 'e1', stores)).toBeNull()
    })
  })

  describe('请求校验', () => {
    it('列表参数：分页默认值与上限，状态只认两个取值', () => {
      expect(LegalEntityListQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 50 })
      expect(LegalEntityListQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false)
      expect(LegalEntityListQuerySchema.safeParse({ status: 'DELETED' }).success).toBe(false)
    })

    it('修改参数：必须带版本，至少改一项，不认识的字段拒绝，注册号可以清空', () => {
      expect(LegalEntityUpdateBodySchema.safeParse({ name: '乙' }).success).toBe(false)
      expect(LegalEntityUpdateBodySchema.safeParse({ version: 1 }).success).toBe(false)
      expect(LegalEntityUpdateBodySchema.safeParse({ version: 1, name: '乙', other: 1 }).success).toBe(false)
      expect(LegalEntityUpdateBodySchema.safeParse({ version: 0, name: '乙' }).success).toBe(false)
      expect(LegalEntityUpdateBodySchema.safeParse({ version: 2, registrationNo: null }).success).toBe(true)
      expect(LegalEntityUpdateBodySchema.safeParse({ version: 2, status: 'INACTIVE', reason: '主体已注销' }).success).toBe(true)
    })
  })
})
