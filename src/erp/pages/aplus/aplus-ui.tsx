import type { ReactNode } from 'react'
import { Alert, Button, Space, Tag, Tooltip, Typography } from 'antd'
import { APLUS_WRITE, type AplusSectionState, type AplusStatus, type AplusWriteStatus } from '@nova/api-contracts'
import { AppLink } from '../../nav/AppLink'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'
import { NONE_TEXT, SECTION_TITLE, STATUS_COLOR, writeBlockOf } from './aplus-format'

// A+ 内容页共用的小件：尚无记录、状态标签、区块状态、口径文字、写入入口的禁用与原因。

export { Muted }
export const NONE = <Muted>{NONE_TEXT}</Muted>

export function StatusTag({ status, label }: { status: AplusStatus; label: string }) {
  return (
    <Tag color={STATUS_COLOR[status]} style={status === 'REJECTED' ? { fontWeight: 600 } : undefined}>
      {label}
    </Tag>
  )
}

export const Basis = ({ children }: { children: ReactNode }) => <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{children}</p>

/** 区块状态：只有不是 OK 才显示；没接入时可以带上处理入口。 */
export function SectionNote({ state, note, remedyPath }: { state: AplusSectionState; note: string | null; remedyPath?: string | null }) {
  if (state === 'OK') return null
  return (
    <Alert
      data-testid="aplus-section-note"
      type={state === 'RESTRICTED' ? 'warning' : 'info'}
      showIcon
      style={{ margin: '8px 0' }}
      message={SECTION_TITLE[state]}
      description={
        <>
          {note}
          {state === 'NOT_CONNECTED' && remedyPath ? (
            <>
              {note ? '　' : ''}
              <AppLink to={remedyPath}>前往处理</AppLink>
            </>
          ) : null}
        </>
      }
    />
  )
}

/** 当前成员能不能写、写入开关通不通：不通时给出原因与处理入口。 */
export function useWriteBlock(write: AplusWriteStatus | undefined) {
  const { canPermission } = useSession()
  return writeBlockOf(write, canPermission(APLUS_WRITE))
}

/** 写入不可用时的说明条（原因 + 处理入口）；可用时不显示。 */
export function WriteNotice({ write }: { write: AplusWriteStatus | undefined }) {
  const block = useWriteBlock(write)
  if (!block) return null
  return (
    <Alert
      data-testid="aplus-write-notice"
      type="warning"
      showIcon
      style={{ margin: '8px 0' }}
      message={block.reason}
      action={block.remedyPath ? <AppLink to={block.remedyPath}>前往处理</AppLink> : undefined}
    />
  )
}

export interface WriteButtonProps {
  label: string
  write: AplusWriteStatus | undefined
  /** 这个动作自己的可用性（例如“审核中不能改”）；不允许时按钮禁用，原因放在提示里。 */
  action?: { allowed: boolean; reason: string | null }
  type?: 'primary' | 'default'
  loading?: boolean
  onClick: () => void
}

/** 所有写入按钮：没权限、写入开关没开、或这个动作自己不允许时禁用，并在提示里写明原因。 */
export function WriteButton({ label, write, action, type = 'default', loading, onClick }: WriteButtonProps) {
  const block = useWriteBlock(write)
  const reason = block?.reason ?? (action && !action.allowed ? (action.reason ?? '当前不能执行这个操作') : null)
  const button = (
    <Button type={type} loading={loading} disabled={reason !== null} onClick={onClick}>
      {label}
    </Button>
  )
  if (reason === null) return button
  return (
    <Space size={4}>
      <Tooltip title={reason}>
        <span>{button}</span>
      </Tooltip>
    </Space>
  )
}

/** 不可用动作的原因（可见文字，不只放在提示里）。 */
export function ActionNotes({ notes }: { notes: Array<{ label: string; reason: string | null }> }) {
  const shown = notes.filter(note => note.reason)
  if (shown.length === 0) return null
  return (
    <ul data-testid="aplus-action-notes" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'rgba(0,0,0,0.55)' }}>
      {shown.map(note => (
        <li key={note.label}>
          <Typography.Text type="secondary">
            不能{note.label}：{note.reason}
          </Typography.Text>
        </li>
      ))}
    </ul>
  )
}

/** 游标翻页：只有上一页与下一页，页码是栈的深度（不显示总页数）。 */
export function Pager({ page, hasNext, busy, onPrev, onNext, note }: { page: number; hasNext: boolean; busy: boolean; onPrev: () => void; onNext: () => void; note?: string }) {
  return (
    <Space style={{ marginTop: 8 }}>
      <Button disabled={page <= 1 || busy} onClick={onPrev}>
        上一页
      </Button>
      <Button disabled={!hasNext || busy} onClick={onNext}>
        下一页
      </Button>
      <span style={{ color: 'rgba(0,0,0,0.45)' }}>
        第 {page} 页{note ? `，${note}` : ''}
      </span>
    </Space>
  )
}
