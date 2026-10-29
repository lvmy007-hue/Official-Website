import { SetMetadata } from '@nestjs/common'
import type { StepUpAction } from '@nova/api-contracts'

export const WRITE_META = 'nova:write'

export interface WriteOptions {
  /** 审计动作名（全大写下划线），例如 LEGAL_ENTITY_CREATED。领域服务自己写审计时仍以服务内的为准 */
  action: string
  /** 审计对象类型，例如 LegalEntity */
  resourceType: string
  /** 先于幂等与再次验证校验的权限点（可选；领域服务内仍会再校验一次） */
  permission?: string
  /** 需要再次验证身份的操作，未验证返回 403 STEP_UP_REQUIRED */
  stepUp?: StepUpAction
  /** 设为 false 表示由领域服务全权负责审计（极少使用，必须有理由） */
  audit?: boolean
  /** 响应里含一次性机密（多因素绑定密钥、恢复码）：幂等记录只保存占位说明，不保存机密本身 */
  sensitiveResponse?: boolean
}

export type WriteMeta = ({ kind: 'write' } & WriteOptions) | { kind: 'exempt'; reason: string }

/**
 * 声明一个写接口（POST/PUT/PATCH/DELETE）：拦截器会统一执行
 * 权限预检 → 再次验证身份 → 幂等键去重 → 业务 → 审计（含请求编号、来源地址、访问模式）。
 */
export const Write = (options: WriteOptions) => SetMetadata(WRITE_META, { kind: 'write', ...options } satisfies WriteMeta)

/**
 * 声明一个不经过幂等与通用审计的写接口。只允许用于：
 * 公开接口（无登录态，按令牌或来源校验）、登录与刷新、第三方回调。必须写明原因。
 */
export const WriteExempt = (reason: string) => SetMetadata(WRITE_META, { kind: 'exempt', reason } satisfies WriteMeta)
