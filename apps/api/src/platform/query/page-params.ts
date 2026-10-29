import { PageParamsSchema } from '@nova/api-contracts'

// 页码分页参数：默认 50，上限 200，超出一律拒绝（返回校验错误），不静默截断。
export function parsePageParams(query: Record<string, unknown>) {
  const { page, pageSize } = PageParamsSchema.parse({ page: query.page, pageSize: query.pageSize })
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize }
}
