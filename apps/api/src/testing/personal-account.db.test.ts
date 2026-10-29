import { defaultNotifyPrefs, type NotifyPrefs } from '@nova/api-contracts'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NotifyService } from '../modules/notifications'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 个人账号（P5-11，真实数据库 + 完整应用 + worker 的写通知与汇总代码）：
// 通知偏好的读写（默认值、整体替换、版本冲突、审计、企业隔离）；显示名修改；
// 按偏好写通知（关掉的组合不写入、免打扰期间标记并不计未读、严重与升级穿透），接口侧与 worker 侧规则一致；
// 免打扰结束后的汇总（只汇总一次、按业务域计数、链接到筛选结果）；消息中心的业务域与免打扰筛选。

type Member = { userId: string; token: string }
type Notice = { kind: string; title: string; body: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; domain?: string; dedupKey?: string }
const ZONE = 'Asia/Shanghai'

// 以当前时刻为中心的免打扰时段（企业本地时区，前后各一小时）与不包含当前时刻的时段
function windowAround(hoursFromNow: number): { start: string; end: string } {
  const at = (offsetHours: number) => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + offsetHours * 3_600_000))
    return `${parts.find(part => part.type === 'hour')?.value}:${parts.find(part => part.type === 'minute')?.value}`
  }
  return { start: at(hoursFromNow - 1), end: at(hoursFromNow + 1) }
}
const quiet = (enabled: boolean, hoursFromNow = 0): NotifyPrefs['dnd'] => ({ enabled, ...windowAround(hoursFromNow) })

describe('个人账号（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let systemDb: PrismaClient
  let tenantId: string
  let otherTenantId: string
  let alice: Member
  let bob: Member
  let carol: Member
  let other: Member
  let notifyUsers: (db: unknown, tenantId: string, userIds: readonly string[], input: Notice) => Promise<number>
  let sendDndSummaries: (db: unknown, now?: Date) => Promise<{ summaries: number; notices: number }>

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const getPrefs = (member: Member) => h.call(member.token, 'GET', '/me/preferences')
  const putPrefs = (member: Member, notify: NotifyPrefs, version: number) => h.call(member.token, 'PUT', '/me/preferences', { body: { notify, version } })
  const unread = async (member: Member) => (await h.call(member.token, 'GET', '/notifications/unread-count')).json.data.unreadCount as number
  const list = async (member: Member, query = '') => (await h.call(member.token, 'GET', `/notifications${query}`)).json.data
  const send = (userIds: string[], input: Notice) => runWithTenant(tenantId, () => notifyUsers(tenantDb, tenantId, userIds, input))
  const prefsWith = (patch: (prefs: NotifyPrefs) => void) => {
    const prefs = defaultNotifyPrefs()
    patch(prefs)
    return prefs
  }

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'personal_account' })
    tenantId = (await h.createTenant('pa-a')).tenantId
    otherTenantId = (await h.createTenant('pa-b')).tenantId
    alice = await h.createMember(tenantId, 'pa-alice', [])
    bob = await h.createMember(tenantId, 'pa-bob', [])
    carol = await h.createMember(tenantId, 'pa-carol', [])
    other = await h.createMember(otherTenantId, 'pa-other', [])
    base = new PrismaClient({ datasourceUrl: h.db.urlFor('personal_account', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    systemDb = new PrismaClient({ datasourceUrl: h.db.urlFor('personal_account', 'system') })
    notifyUsers = (await import(/* @vite-ignore */ String('../../../worker/src/platform/notify'))).notifyUsers
    sendDndSummaries = (await import(/* @vite-ignore */ String('../../../worker/src/platform/dnd-summary'))).sendDndSummaries
  })
  afterAll(async () => {
    await base?.$disconnect()
    await systemDb?.$disconnect()
    await h?.close()
  })

  it('没登录 401；没保存过：默认全部接收、免打扰关闭、版本 0，时区是企业本地时区', async () => {
    expect((await h.call(null, 'GET', '/me/preferences')).status).toBe(401)
    const res = await getPrefs(alice)
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ notify: defaultNotifyPrefs(), favorites: [], density: 'STANDARD', version: 0, updatedAt: null, zone: ZONE })
  })

  it('保存偏好：创建、再次保存版本加一、写审计（前后值）；版本过期 409；没变化 422；别的成员与别的企业看不到', async () => {
    const first = prefsWith(prefs => {
      prefs.domains.ADS.INFO = false
      prefs.dnd = { enabled: true, start: '23:00', end: '07:00' }
    })
    const created = await putPrefs(alice, first, 0)
    expect(created.status).toBe(200)
    expect(created.json.data).toMatchObject({ notify: first, version: 1 })
    expect((await putPrefs(alice, first, 1)).status).toBe(422)
    const second = prefsWith(prefs => {
      prefs.domains.FINANCE.WARNING = false
    })
    const updated = await putPrefs(alice, second, 1)
    expect(updated.json.data).toMatchObject({ notify: second, version: 2 })
    expect((await putPrefs(alice, first, 1)).status).toBe(409) // 版本已是 2
    expect((await putPrefs(bob, first, 5)).status).toBe(409) // bob 没有记录，却带着旧版本
    expect((await getPrefs(alice)).json.data).toMatchObject({ notify: second, version: 2 })
    expect((await getPrefs(bob)).json.data).toMatchObject({ notify: defaultNotifyPrefs(), version: 0 })
    expect((await getPrefs(other)).json.data.version).toBe(0)
    const audits = await rows<{ beforeJson: { notify: NotifyPrefs } | null; afterJson: { notify: NotifyPrefs } | null }>(
      `SELECT "beforeJson", "afterJson" FROM "AuditEvent" WHERE "tenantId" = $1 AND "actorId" = $2 AND action = 'USER_PREFERENCES_UPDATED' AND "result" = 'SUCCEEDED' AND "beforeJson" IS NOT NULL ORDER BY "occurredAt", id`,
      [tenantId, alice.userId],
    )
    expect(audits).toHaveLength(2)
    expect(audits[0]?.beforeJson?.notify).toEqual(defaultNotifyPrefs())
    expect(audits[1]?.afterJson?.notify).toEqual(second)
    await putPrefs(alice, defaultNotifyPrefs(), 2) // 还原，后面的用例从默认开始
  })

  it('不完整的偏好 422；免打扰起止相同 422；同一成员在两个企业各有一份', async () => {
    const same = defaultNotifyPrefs()
    same.dnd = { enabled: true, start: '08:00', end: '08:00' }
    expect((await putPrefs(bob, same, 0)).status).toBe(422)
    expect((await h.call(bob.token, 'PUT', '/me/preferences', { body: { notify: { domains: {}, dnd: defaultNotifyPrefs().dnd }, version: 0 } })).status).toBe(422)
    const prefs = await rows<{ tenantId: string; userId: string }>(`SELECT "tenantId", "userId" FROM "UserPreference" ORDER BY "tenantId", "userId"`)
    expect(prefs.every(row => row.tenantId === tenantId)).toBe(true)
  })

  it('修改显示名：登录身份里立刻变化，写审计；没有变化不写；空名 422', async () => {
    expect((await h.call(carol.token, 'PATCH', '/auth/me', { body: { displayName: '   ' } })).status).toBe(422)
    const res = await h.call(carol.token, 'PATCH', '/auth/me', { body: { displayName: '  王小明  ' } })
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ displayName: '王小明', changed: true })
    expect((await h.call(carol.token, 'GET', '/auth/me')).json.data.user.displayName).toBe('王小明')
    expect((await h.call(carol.token, 'PATCH', '/auth/me', { body: { displayName: '王小明' } })).json.data.changed).toBe(false)
    const audits = await rows<{ beforeJson: { displayName: string }; afterJson: { displayName: string } }>(
      `SELECT "beforeJson", "afterJson" FROM "AuditEvent" WHERE "tenantId" = $1 AND "actorId" = $2 AND action = 'PROFILE_UPDATED' AND "result" = 'SUCCEEDED' AND "beforeJson" IS NOT NULL`,
      [tenantId, carol.userId],
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]?.afterJson).toEqual({ displayName: '王小明' })
    expect((await h.call(bob.token, 'GET', '/auth/me')).json.data.user.displayName).not.toBe('王小明')
  })

  it('默认偏好：所有通知正常送达，带业务域，计入未读', async () => {
    await send([bob.userId], { kind: 'ALERT_RULE', domain: 'INVENTORY', title: '库存预警', body: 'x', severity: 'WARNING', dedupKey: 'pa-1' })
    await send([bob.userId], { kind: 'WORK_ASSIGNED', title: '新待办', body: 'x', severity: 'INFO', dedupKey: 'pa-2' })
    expect(await unread(bob)).toBe(2)
    const data = await list(bob)
    expect(data.items.map((item: { domain: string; silenced: boolean }) => [item.domain, item.silenced]).sort()).toEqual([
      ['INVENTORY', false],
      ['WORK', false],
    ])
  })

  it('关掉的“业务域 × 级别”不写入（连严重级别也不例外），其余照常', async () => {
    const prefs = prefsWith(p => {
      p.domains.ADS.INFO = false
      p.domains.FINANCE.CRITICAL = false
    })
    expect((await putPrefs(carol, prefs, 0)).status).toBe(200)
    expect(await send([carol.userId], { kind: 'ADS_RULE', title: '广告建议', body: 'x', severity: 'INFO', dedupKey: 'pa-3' })).toBe(0)
    expect(await send([carol.userId], { kind: 'ALERT_RULE', domain: 'FINANCE', title: '结算差异', body: 'x', severity: 'CRITICAL', dedupKey: 'pa-4' })).toBe(0)
    expect(await send([carol.userId], { kind: 'ALERT_RULE', domain: 'FINANCE', title: '结算差异', body: 'x', severity: 'WARNING', dedupKey: 'pa-5' })).toBe(1)
    expect(await send([carol.userId, bob.userId], { kind: 'ADS_RULE', title: '广告建议', body: 'x', severity: 'INFO', dedupKey: 'pa-6' })).toBe(1) // 只有 bob 收到
    expect((await list(carol)).items).toHaveLength(1)
    await putPrefs(carol, defaultNotifyPrefs(), 1)
  })

  describe('免打扰', () => {
    let version = 0
    it('开启并覆盖此刻：普通通知写入但标记免打扰、不计未读；严重级别与超时升级照常提醒', async () => {
      const before = await unread(alice)
      const prefs = prefsWith(p => {
        p.dnd = quiet(true)
      })
      const saved = await putPrefs(alice, prefs, (await getPrefs(alice)).json.data.version)
      version = saved.json.data.version
      expect(saved.status).toBe(200)
      expect(await send([alice.userId], { kind: 'ALERT_RULE', domain: 'INVENTORY', title: '库存预警', body: 'x', severity: 'WARNING', dedupKey: 'pa-d1' })).toBe(1)
      expect(await send([alice.userId], { kind: 'ADS_RULE', title: '广告建议', body: 'x', severity: 'INFO', dedupKey: 'pa-d2' })).toBe(1)
      expect(await send([alice.userId], { kind: 'WORK_ASSIGNED', title: '新待办', body: 'x', severity: 'INFO', dedupKey: 'pa-d3' })).toBe(1)
      expect(await unread(alice)).toBe(before) // 都被压下，没有提醒
      await send([alice.userId], { kind: 'ALERT_RULE', domain: 'INVENTORY', title: '严重断货', body: 'x', severity: 'CRITICAL', dedupKey: 'pa-d4' })
      await send([alice.userId], { kind: 'WORK_OVERDUE', title: '待办超时', body: 'x', severity: 'WARNING', dedupKey: 'pa-d5' })
      await send([alice.userId], { kind: 'WORK_ESCALATED', title: '已升级', body: 'x', severity: 'WARNING', dedupKey: 'pa-d6' })
      expect(await unread(alice)).toBe(before + 3)
    })

    it('接口侧的 NotifyService 与 worker 规则一致：同一份偏好下同样被压下', async () => {
      const service = h.app.get(NotifyService, { strict: false })
      const written = await runWithTenant(tenantId, () => service.toUsers(tenantId, [alice.userId], { kind: 'MENTION', title: '有人提到你', body: 'x', severity: 'INFO', dedupKey: 'pa-d7' }))
      expect(written).toBe(1)
      const silenced = await rows<{ title: string; silencedAt: Date | null }>(`SELECT title, "silencedAt" FROM "Notification" WHERE "tenantId" = $1 AND "dedupKey" = 'pa-d7'`, [tenantId])
      expect(silenced[0]?.silencedAt).not.toBeNull()
      const critical = await runWithTenant(tenantId, () =>
        service.toUsers(tenantId, [alice.userId], { kind: 'ALERT_FX_FETCH_FAILED', title: '汇率失败', body: 'x', severity: 'CRITICAL', dedupKey: 'pa-d8' }),
      )
      expect(critical).toBe(1)
      const loud = await rows<{ silencedAt: Date | null; domain: string }>(`SELECT "silencedAt", domain FROM "Notification" WHERE "tenantId" = $1 AND "dedupKey" = 'pa-d8'`, [tenantId])
      expect(loud[0]).toMatchObject({ silencedAt: null, domain: 'SYSTEM' })
    })

    it('消息中心：被压下的通知仍然看得到，可以按免打扰与业务域筛选；未读筛选不含它们', async () => {
      const silenced = await list(alice, '?silenced=true')
      expect(silenced.items.map((item: { title: string }) => item.title).sort()).toEqual(['广告建议', '库存预警', '新待办', '有人提到你'].sort())
      expect(silenced.items.every((item: { silenced: boolean }) => item.silenced)).toBe(true)
      const ads = await list(alice, '?silenced=true&domain=ADS')
      expect(ads.items.map((item: { title: string }) => item.title)).toEqual(['广告建议'])
      const unreadOnly = await list(alice, '?unread=true')
      expect(unreadOnly.items.some((item: { silenced: boolean }) => item.silenced)).toBe(false)
      expect((await list(alice, '?silenced=false')).items.every((item: { silenced: boolean }) => !item.silenced)).toBe(true)
    })

    it('时段还没结束：不汇总；时段结束（改到别的时间）后汇总一次，按业务域列出条数并链接到筛选结果', async () => {
      expect(await sendDndSummaries(systemDb)).toEqual({ summaries: 0, notices: 0 })
      const moved = prefsWith(p => {
        p.dnd = quiet(true, 6)
      })
      expect((await putPrefs(alice, moved, version)).status).toBe(200)
      const before = await unread(alice)
      expect(await sendDndSummaries(systemDb)).toEqual({ summaries: 1, notices: 4 })
      expect(await sendDndSummaries(systemDb)).toEqual({ summaries: 0, notices: 0 }) // 只汇总一次
      expect(await unread(alice)).toBe(before + 1)
      const summary = (await list(alice)).items.find((item: { kind: string }) => item.kind === 'DND_SUMMARY')
      expect(summary).toMatchObject({ title: '免打扰期间收到 4 条通知', severity: 'INFO', domain: 'SYSTEM', silenced: false, link: '/app/my/notifications?silenced=true' })
      expect(summary.body).toBe('免打扰期间没有逐条提醒：库存 1 条、广告 1 条、待办与协作 2 条。')
      const open = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "Notification" WHERE "tenantId" = $1 AND "userId" = $2 AND "silencedAt" IS NOT NULL AND "summarizedAt" IS NULL`, [
        tenantId,
        alice.userId,
      ])
      expect(open[0]?.n).toBe(0)
      expect((await list(alice, '?silenced=true')).items).toHaveLength(4) // 原通知仍可查看
    })

    it('关掉免打扰后，没汇总的也会在下一轮并入汇总；只有一个业务域时链接带筛选；别的企业的通知互不影响', async () => {
      const prefs = prefsWith(p => {
        p.dnd = quiet(true, 6)
      })
      const saved = await getPrefs(alice)
      await putPrefs(alice, { ...saved.json.data.notify, dnd: quiet(true) }, saved.json.data.version)
      await send([alice.userId], { kind: 'ADS_RULE', title: '广告建议二', body: 'x', severity: 'INFO', dedupKey: 'pa-d9' })
      await h.client.query(`UPDATE "UserPreference" SET "notifyJson" = $1::jsonb, version = version + 1 WHERE "tenantId" = $2 AND "userId" = $3`, [
        JSON.stringify({ ...prefs, dnd: { ...prefs.dnd, enabled: false } }),
        tenantId,
        alice.userId,
      ])
      expect(await sendDndSummaries(systemDb)).toEqual({ summaries: 1, notices: 1 })
      const summaries = (await list(alice)).items.filter((item: { kind: string }) => item.kind === 'DND_SUMMARY')
      expect(summaries).toHaveLength(2)
      expect(summaries.some((item: { link: string }) => item.link === '/app/my/notifications?silenced=true&domain=ADS')).toBe(true)
      expect((await list(other)).items).toEqual([])
    })
  })
})
