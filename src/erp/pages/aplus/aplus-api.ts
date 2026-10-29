import type { AplusFormModule, AplusUploadResult, AplusUploadTicket, AplusWriteResult } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { conflictVersions } from '../../concurrency/conflict'
import { useApiMutation } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { imageFileIssue } from './aplus-format'

// A+ 内容的请求封装（P4-14）：写入四件事（新建、保存修改、关联 ASIN、提交审核）与图片上传三步。
// 写入都是“受理后异步执行”：成功响应只代表已登记（QUEUED），结果在详情页的“写入记录”里看。
// 请求体的校验在服务端（zod 在 aplus-query.ts，前端不导入，免得首屏脚本多出校验库）；前端只做 aplus-modules 里的本地校验。

export interface CreateVariables {
  storeId: string
  name: string
  modules: AplusFormModule[]
}
export interface UpdateVariables {
  id: string
  version: number
  name?: string
  modules?: AplusFormModule[]
}
export interface AsinsVariables {
  id: string
  version: number
  asins: string[]
}
export interface SubmitVariables {
  id: string
  version: number
}

const enc = encodeURIComponent

/** 新建：先存本地再由后台任务在亚马逊创建；locale 与 contentType 用接口默认值（en-US、标准 A+）。 */
export const useCreateAplus = () =>
  useApiMutation<CreateVariables, AplusWriteResult>({
    method: 'POST',
    path: '/aplus',
    body: ({ storeId, name, modules }) => ({ storeId, name, locale: 'en-US', contentType: 'EBC', modules }),
    invalidate: ['list'],
    silent: true,
  })

/** 保存修改：必须带版本号；名称与模块没改的不传。 */
export const useUpdateAplus = () =>
  useApiMutation<UpdateVariables, AplusWriteResult>({
    method: 'PATCH',
    path: ({ id }) => `/aplus/${enc(id)}`,
    body: ({ version, name, modules }) => ({ version, ...(name !== undefined ? { name } : {}), ...(modules !== undefined ? { modules } : {}) }),
    invalidate: ['list'],
    silent: true,
  })

export const useAssociateAsins = () =>
  useApiMutation<AsinsVariables, AplusWriteResult>({
    method: 'POST',
    path: ({ id }) => `/aplus/${enc(id)}/asins`,
    body: ({ version, asins }) => ({ version, asins }),
    invalidate: ['list'],
    silent: true,
  })

export const useSubmitAplus = () =>
  useApiMutation<SubmitVariables, AplusWriteResult>({
    method: 'POST',
    path: ({ id }) => `/aplus/${enc(id)}/submit`,
    body: ({ version }) => ({ version }),
    invalidate: ['list'],
    silent: true,
  })

/** 写入失败的提示文字；版本冲突（409 CONFLICT，别人刚改过）要提醒刷新，别的 409（例如写入开关没开）原样显示原因。 */
export function writeErrorText(error: unknown): string {
  const info = describeError(error)
  const base = info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message
  return conflictVersions(error) ? `${base}。内容刚被改过，请刷新页面看到最新版本后再操作` : base
}

/** 上传某一步失败：带上是哪一步，页面直接显示 message。 */
export class UploadStepError extends Error {
  constructor(
    readonly step: 'ticket' | 'transfer' | 'confirm',
    message: string,
  ) {
    super(message)
  }
}

/**
 * 图片上传三步：① 申请直传票据 → ② 浏览器把文件 PUT 到存储 → ③ 确认并登记上传任务。
 * 类型与大小先在本地校验（不合格不发任何请求）；任何一步失败都用中文说明是哪一步、为什么，不做假成功。
 */
export async function uploadAplusImage(file: File, storeId: string): Promise<AplusUploadResult> {
  const issue = imageFileIssue(file)
  if (issue) throw new UploadStepError('ticket', issue)
  let ticket: AplusUploadTicket
  try {
    ticket = await apiFetch<AplusUploadTicket>('/aplus/uploads', { method: 'POST', body: JSON.stringify({ storeId, fileName: file.name, contentType: file.type, sizeBytes: file.size }) })
  } catch (error) {
    throw new UploadStepError('ticket', `申请上传凭据失败：${describeError(error).message}`)
  }
  try {
    const sent = await fetch(ticket.uploadUrl, { method: ticket.method, headers: ticket.headers, body: file })
    if (!sent.ok) throw new Error(`存储返回 ${sent.status}`)
  } catch (error) {
    throw new UploadStepError('transfer', `图片没能传到存储：${error instanceof Error ? error.message : '网络连接失败'}，请重新上传`)
  }
  try {
    return await apiFetch<AplusUploadResult>('/aplus/uploads/confirm', { method: 'POST', body: JSON.stringify({ storeId, objectKey: ticket.objectKey, fileName: file.name, contentType: file.type }) })
  } catch (error) {
    throw new UploadStepError('confirm', `图片已传到存储，但确认登记失败：${describeError(error).message}`)
  }
}
