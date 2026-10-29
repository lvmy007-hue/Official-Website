import type { NextFunction, Request, Response } from 'express'

// 查询参数形状守卫（P5-13，注入核查）：框架默认把 `?q[$ne]=1` 解析成对象、把重复的键解析成数组。
// 前端只会发“每个键一个字符串”（多选值用逗号连接，见 src/erp/query/api-query.ts），所以其余写法都不是正常请求。
// 不在入口拒绝的话，直接把查询参数当字符串用的服务（尤其是尚未改成 zod 校验的旧接口）会把对象原样交给数据库查询层，
// 变成“操作符注入”（改变筛选语义）或 500。这里统一在入口返回 400，不依赖每个接口各自记得校验。
export function hasNonStringQuery(query: unknown): boolean {
  if (query === null || typeof query !== 'object') return false
  return Object.values(query).some(value => typeof value !== 'string')
}

export function queryShapeGuard(req: Request, res: Response, next: NextFunction) {
  if (!hasNonStringQuery(req.query)) return next()
  const requestId = (req as Request & { requestId?: string }).requestId ?? 'unknown'
  res.status(400).json({
    success: false,
    error: { code: 'BAD_REQUEST', message: '查询参数格式不正确：每个参数只能出现一次，且不支持嵌套或数组写法', requestId, retryable: false },
  })
}
