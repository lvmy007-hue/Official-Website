import type { EventsResponse, EventType } from '@nova/api-contracts'
import { useApiQuery } from '../../query/api-query'

// 统一事件接口（GET /events，P6-06）的取数：按对象与时间段读，权限与数据范围由服务端按对象过滤。
// 事件不随全局范围参数（范围由对象本身决定），所以不带范围；每类最多 200 条，超出时响应里标记截断。

export type EventSource = { objectType: string; objectId: string }

export function useObjectEvents(source: EventSource, range: { from: string; to: string } | null, types?: readonly EventType[]) {
  return useApiQuery<EventsResponse>({
    domain: 'list',
    path: '/events',
    params: { objectType: source.objectType, objectId: source.objectId, from: range?.from, to: range?.to, types: types ? [...types] : undefined },
    scoped: false,
    enabled: range !== null,
  })
}
