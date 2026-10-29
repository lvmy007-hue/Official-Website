import { describe, expect, it, vi } from 'vitest'
import type { RequestWithContext } from '../http'
import type { PrismaService } from '../prisma.service'
import { AuditWriter } from './audit-writer.service'

// 审计写入的来源与所属页面（P5-09）：页面头合格记为页面操作，否则记为接口调用。

const context = { tenantId: 't1', userId: 'u1' }
const requestWith = (page?: string) => ({ requestId: 'req-1', ip: '203.0.113.1', header: (name: string) => (name === 'x-nova-page' ? page : undefined) }) as unknown as RequestWithContext
const writer = () => new AuditWriter({} as PrismaService)
const entry = { action: 'ROLE_UPDATED', resourceType: 'Role' }

describe('审计写入的来源与页面', () => {
  it('带合格的页面路径：页面操作，路径去掉参数与片段并把编号规范成 :id', () => {
    expect(writer().build(requestWith('/app/orders/12345678?tab=1#x'), context, entry)).toMatchObject({ source: 'PAGE', page: '/app/orders/:id' })
    expect(writer().build(requestWith('/app/audit/'), context, entry)).toMatchObject({ source: 'PAGE', page: '/app/audit' })
  })

  it('没有页面头、头里不是站内路径、过长：接口调用，页面为空', () => {
    for (const page of [undefined, '', 'javascript:alert(1)', 'https://evil.example/app', `/app/${'a'.repeat(200)}`])
      expect(writer().build(requestWith(page), context, entry), String(page)).toMatchObject({ source: 'API', page: null })
  })

  it('record 写入时带上来源与页面', async () => {
    const create = vi.fn().mockResolvedValue({})
    await new AuditWriter({ auditEvent: { create } } as unknown as PrismaService).record(requestWith('/app/audit'), entry, { context })
    expect(create.mock.calls[0][0].data).toMatchObject({ source: 'PAGE', page: '/app/audit', tenantId: 't1', actorId: 'u1' })
  })
})
