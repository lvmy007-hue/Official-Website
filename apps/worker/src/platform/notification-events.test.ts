import { describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_EVENT_RETENTION_DAYS, NotificationProcessorRegistry, purgeExpiredNotificationEvents, replayEvents } from './notification-events'

const NOW = new Date('2026-10-22T08:00:00Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000)
const event = (id: string, over: Record<string, any> = {}) => ({
  id,
  tenantId: 't1',
  sellerAccountId: 's1',
  notificationType: 'ORDER_CHANGE',
  payloadObjectKey: `events/${id}.json`,
  status: 'RECEIVED',
  attempts: 0,
  receivedAt: daysAgo(1),
  ...over,
})

function makeDb(rows: Array<Record<string, any>>) {
  return {
    amazonNotificationEvent: {
      findMany: vi.fn(async ({ where, take }: any) =>
        rows
          .filter(
            row =>
              (!where.tenantId || row.tenantId === where.tenantId) &&
              (!where.id?.in || where.id.in.includes(row.id)) &&
              (!where.id?.notIn || !where.id.notIn.includes(row.id)) &&
              (!where.status || row.status === where.status) &&
              (!where.receivedAt?.lt || row.receivedAt < where.receivedAt.lt),
          )
          .sort((a, b) => a.receivedAt - b.receivedAt)
          .slice(0, take),
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = rows.find(item => item.id === where.id)!
        const { attempts, ...rest } = data
        Object.assign(row, rest, attempts ? { attempts: row.attempts + 1 } : {})
        return { count: 1 }
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        let count = 0
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (where.id.in.includes(rows[index].id) && rows[index].receivedAt < where.receivedAt.lt) {
            rows.splice(index, 1)
            count += 1
          }
        }
        return { count }
      }),
    },
  }
}

describe('通知事件重放', () => {
  it('有处理器的类型：处理成功标记已处理并记处理时间；没有处理器的类型如实标记失败', async () => {
    const rows = [event('e1'), event('e2', { notificationType: 'ANY_OFFER_CHANGED' })]
    const handled: string[] = []
    const processors = new NotificationProcessorRegistry().register('ORDER_CHANGE', async item => void handled.push(item.id))
    const result = await replayEvents({ db: makeDb(rows) as never, processors, now: () => NOW }, 't1', ['e1', 'e2'])
    expect(result).toEqual({ processed: 1, failed: 1 })
    expect(handled).toEqual(['e1'])
    expect(rows[0]).toMatchObject({ status: 'PROCESSED', processedAt: NOW, errorCode: null, attempts: 1 })
    expect(rows[1]).toMatchObject({ status: 'FAILED', errorCode: 'PROCESSOR_NOT_AVAILABLE', attempts: 1 })
  })

  it('处理器抛错：记失败；错误码只取规范的大写代码，不把内部错误文本写进库', async () => {
    const rows = [event('e1'), event('e2')]
    let n = 0
    const processors = new NotificationProcessorRegistry().register('ORDER_CHANGE', async () => {
      n += 1
      throw n === 1 ? Object.assign(new Error('secret detail'), { code: 'PAYLOAD_INVALID' }) : new Error('secret detail')
    })
    await replayEvents({ db: makeDb(rows) as never, processors }, 't1', ['e1', 'e2'])
    expect(rows[0].errorCode).toBe('PAYLOAD_INVALID')
    expect(rows[1].errorCode).toBe('PROCESSING_FAILED')
  })

  it('只处理“已接收”的本租户事件；其他租户、已处理的不碰；一次最多 200 条', async () => {
    const rows = [event('e1', { tenantId: 't2' }), event('e2', { status: 'PROCESSED' }), event('e3')]
    const processor = vi.fn(async () => undefined)
    const processors = new NotificationProcessorRegistry().register('ORDER_CHANGE', processor)
    const result = await replayEvents({ db: makeDb(rows) as never, processors }, 't1', ['e1', 'e2', 'e3'])
    expect(result).toEqual({ processed: 1, failed: 0 })
    expect(processor).toHaveBeenCalledTimes(1)
    const db = makeDb([])
    await replayEvents(
      { db: db as never, processors },
      't1',
      Array.from({ length: 250 }, (_, index) => `e${index}`),
    )
    expect(db.amazonNotificationEvent.findMany.mock.calls[0][0].where.id.in).toHaveLength(200)
  })
})

describe('通知事件到期清理', () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn() })

  it(`保留 ${NOTIFICATION_EVENT_RETENTION_DAYS} 天：先删消息体再删记录；未到期的不动`, async () => {
    const rows = [event('old1', { receivedAt: daysAgo(91) }), event('old2', { receivedAt: daysAgo(200) }), event('keep', { receivedAt: daysAgo(89) })]
    const storage = { delete: vi.fn(async () => undefined) }
    const log = logger()
    const result = await purgeExpiredNotificationEvents({ systemDb: makeDb(rows) as never, storage, logger: log, now: () => NOW })
    expect(result).toEqual({ deleted: 2, failed: 0 })
    expect(storage.delete.mock.calls.map(call => call[0]).sort()).toEqual(['events/old1.json', 'events/old2.json'])
    expect(rows.map(row => row.id)).toEqual(['keep'])
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('消息体删除失败的记录保留（下次再试），其余照常删除；不会因失败记录无限循环', async () => {
    const rows = [event('bad', { receivedAt: daysAgo(100) }), event('ok', { receivedAt: daysAgo(99) })]
    const storage = { delete: vi.fn(async (key: string) => (key.includes('bad') ? Promise.reject(new Error('io')) : undefined)) }
    const log = logger()
    const result = await purgeExpiredNotificationEvents({ systemDb: makeDb(rows) as never, storage, logger: log, now: () => NOW })
    expect(result).toEqual({ deleted: 1, failed: 1 })
    expect(rows.map(row => row.id)).toEqual(['bad'])
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('没有到期事件：什么都不做也不写日志', async () => {
    const storage = { delete: vi.fn() }
    const log = logger()
    expect(await purgeExpiredNotificationEvents({ systemDb: makeDb([event('a')]) as never, storage, logger: log, now: () => NOW })).toEqual({ deleted: 0, failed: 0 })
    expect(storage.delete).not.toHaveBeenCalled()
    expect(log.info).not.toHaveBeenCalled()
  })
})
