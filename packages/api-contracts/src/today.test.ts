import { describe, expect, it } from 'vitest'
import { TODAY_ADS_NOTE, TODAY_ESTIMATE_NOTE, TODAY_METRIC_VERSION, TODAY_NOT_CONNECTED_NOTE, TodayEventsQuerySchema } from './today.js'

describe('今日实时契约', () => {
  it('游标参数默认页大小 50，上限 200', () => {
    expect(TodayEventsQuerySchema.parse({})).toMatchObject({ pageSize: 50 })
    expect(TodayEventsQuerySchema.parse({ pageSize: '200' }).pageSize).toBe(200)
    expect(() => TodayEventsQuerySchema.parse({ pageSize: '201' })).toThrow()
  })

  it('状态文案与版本常量固定，供前后端共用', () => {
    expect(TODAY_METRIC_VERSION).toBe('p2a-03@1')
    expect(TODAY_ESTIMATE_NOTE).toContain('日终')
    expect(TODAY_NOT_CONNECTED_NOTE).toContain('AMAZON_NOTIFICATION_DESTINATION_ID')
    expect(TODAY_ADS_NOTE).toContain('营销数据流')
  })
})
