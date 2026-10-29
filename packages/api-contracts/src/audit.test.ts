import { describe, expect, it } from 'vitest'
import { AuditListQuerySchema, PiiViewQuerySchema } from './audit-query.js'
import { auditFilterClauses, auditFiltersFromExport, piiViewClauses } from './audit-where.js'
import { AUDIT_FORMER_MEMBER_LABEL, auditActorOf, auditPageOf, auditResourcePath, auditSourceOf } from './audit.js'
import { EXPORT_KINDS, exportKindOf } from './exports.js'

// 审计中心契约（P5-09）：来源与页面判断、操作人判断、筛选条件、导出目录。

describe('来源与所属页面', () => {
  it('来源列有值就用它；旧记录没有操作人按系统任务，有操作人无法判断', () => {
    expect(auditSourceOf('PAGE', null)).toBe('PAGE')
    expect(auditSourceOf(null, null)).toBe('SYSTEM')
    expect(auditSourceOf(null, 'u1')).toBeNull()
    expect(auditSourceOf('ROBOT', 'u1')).toBeNull()
  })

  it('页面路径：去参数与片段、编号归一；不是站内路径或过长的不认', () => {
    expect(auditPageOf('/app/orders/12345678?tab=1#x')).toBe('/app/orders/:id')
    expect(auditPageOf('/app/audit/')).toBe('/app/audit')
    expect(auditPageOf('/app')).toBe('/app')
    for (const raw of [undefined, null, 5, '', '/other', 'https://x/app', '/app/<script>', `/app/${'a'.repeat(70)}`, '/app/a/b/c/d/e/f/g']) expect(auditPageOf(raw), String(raw)).toBeNull()
  })

  it('资源类型对应的详情路径只在有详情页时给', () => {
    expect(auditResourcePath('Order', 'o 1')).toBe('/app/orders/o%201')
    expect(auditResourcePath('Role', 'r1')).toBe('/app/roles')
    expect(auditResourcePath('Order', null)).toBeNull()
    expect(auditResourcePath('Unknown', 'x')).toBeNull()
  })
})

describe('操作人', () => {
  const names = new Map([['u1', '林客服']])
  it('平台人员、系统（含后台任务代写，保留发起人编号）、成员、已离开的成员、未记录', () => {
    expect(auditActorOf({ actorId: null, source: 'API', detail: { accessMode: 'SUPPORT' } }, names)).toMatchObject({ name: '平台人员', kind: 'SUPPORT', id: null })
    expect(auditActorOf({ actorId: 'support:p1', source: 'API', detail: null }, names)).toMatchObject({ kind: 'SUPPORT' })
    expect(auditActorOf({ actorId: 'u1', source: 'SYSTEM', detail: null }, names)).toEqual({ id: 'u1', name: '系统', kind: 'SYSTEM' })
    expect(auditActorOf({ actorId: null, source: null, detail: null }, names)).toMatchObject({ name: '系统', kind: 'SYSTEM' })
    expect(auditActorOf({ actorId: 'u1', source: 'PAGE', detail: null }, names)).toEqual({ id: 'u1', name: '林客服', kind: 'USER' })
    expect(auditActorOf({ actorId: 'gone', source: 'PAGE', detail: null }, names).name).toBe(AUDIT_FORMER_MEMBER_LABEL)
    expect(auditActorOf({ actorId: 'u2', source: null, detail: null }, new Map())).toMatchObject({ kind: 'USER', name: AUDIT_FORMER_MEMBER_LABEL })
  })
})

describe('筛选条件', () => {
  it('没有筛选就没有条件；每个筛选各占一条；来源为系统任务时包含没有来源列也没有操作人的旧记录', () => {
    expect(auditFilterClauses({})).toEqual([])
    const clauses = auditFilterClauses({ actorId: 'u1', action: 'A', resourceType: 'Role', resourceId: 'r1', result: 'DENIED', requestId: 'q1', page: '/app/x', source: 'SYSTEM' })
    expect(clauses).toHaveLength(8)
    expect(clauses).toContainEqual({ OR: [{ source: 'SYSTEM' }, { source: null, actorId: null }] })
    expect(auditFilterClauses({ source: 'PAGE' })).toEqual([{ source: 'PAGE' }])
  })

  it('时间范围与关键词；明文查看视图的动作固定', () => {
    const from = new Date('2026-10-01T00:00:00Z')
    const to = new Date('2026-10-02T00:00:00Z')
    expect(auditFilterClauses({ fromAt: from, toAt: to })).toEqual([{ occurredAt: { gte: from, lte: to } }])
    expect(JSON.stringify(auditFilterClauses({ q: 'ab' }))).toContain('"startsWith":"ab"')
    const pii = piiViewClauses({ q: '111-1' })
    expect(pii[0]).toEqual({ action: { in: ['ORDER_BUYER_PII_VIEWED', 'PII_REVEALED'] } })
    expect(JSON.stringify(pii)).toContain('amazonOrderId')
  })

  it('导出保存的筛选还原成条件：只认白名单键，空白丢弃，解析不了的时间丢弃', () => {
    expect(auditFiltersFromExport({ action: ' A ', result: '', bogus: 'x', fromAt: '2026-10-01T00:00:00Z', toAt: 'bad' })).toEqual({
      actorId: undefined,
      action: 'A',
      resourceType: undefined,
      resourceId: undefined,
      result: undefined,
      source: undefined,
      page: undefined,
      requestId: undefined,
      q: undefined,
      fromAt: new Date('2026-10-01T00:00:00Z'),
      toAt: undefined,
    })
  })
})

describe('查询参数', () => {
  it('列表：不认识的参数、起止颠倒、不合法的取值都拒绝', () => {
    expect(AuditListQuerySchema.safeParse({}).success).toBe(true)
    expect(AuditListQuerySchema.safeParse({ nope: '1' }).success).toBe(false)
    expect(AuditListQuerySchema.safeParse({ result: 'BOGUS' }).success).toBe(false)
    expect(AuditListQuerySchema.safeParse({ source: 'ROBOT' }).success).toBe(false)
    expect(AuditListQuerySchema.safeParse({ fromAt: '2026-10-02T00:00:00Z', toAt: '2026-10-01T00:00:00Z' }).success).toBe(false)
    expect(AuditListQuerySchema.safeParse({ fromAt: 'yesterday' }).success).toBe(false)
    expect(AuditListQuerySchema.safeParse({ source: 'SYSTEM', result: 'FAILED', page: '/app/audit' }).success).toBe(true)
  })

  it('明文查看视图只有操作人、关键词与时间范围', () => {
    expect(PiiViewQuerySchema.safeParse({ actorId: 'u1', q: '111' }).success).toBe(true)
    expect(PiiViewQuerySchema.safeParse({ action: 'X' }).success).toBe(false)
  })
})

describe('导出目录', () => {
  it('审计日志：不分店铺、要审计读取权限、列齐全；筛选键与列表筛选一致', () => {
    const spec = exportKindOf('audit-events')
    expect(spec).toMatchObject({ permission: 'audit.read', storeScoped: false, sourcePage: '/app/audit' })
    expect(spec?.columns.map(column => column.key)).toEqual(expect.arrayContaining(['occurredAt', 'actorName', 'sourceLabel', 'page', 'action', 'resourceId', 'resultLabel', 'ip', 'requestId']))
    expect(spec?.filterKeys).toEqual(expect.arrayContaining(['actorId', 'action', 'resourceType', 'resourceId', 'result', 'source', 'page', 'requestId', 'q', 'fromAt', 'toAt']))
    expect(spec?.columns.some(column => column.sensitive)).toBe(false)
    expect(EXPORT_KINDS.filter(kind => kind.storeScoped === false).map(kind => kind.kind)).toEqual(['audit-events'])
  })
})
