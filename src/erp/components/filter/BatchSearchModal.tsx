import { useState } from 'react'
import { Input, Modal, Typography } from 'antd'
import { BATCH_ITEM_MAX, BATCH_MAX_CHARS, BATCH_MAX_ITEMS, joinBatchTerms, parseBatchTerms } from '@nova/api-contracts'

// 批量搜索弹窗（P6-04）：一次粘贴多行，去空行、去重、数个数；超过 500 个、含超长项或总长度超限时不让提交并写明原因。
// 确定后写入的是“精确匹配”的批量词（逗号连接），和搜索框里的单项（前缀 / 包含）搜索互不覆盖。

type Props = {
  open: boolean
  title: string
  /** 弹窗打开时文本框里的内容（已生效的批量词，或刚粘贴的内容）。 */
  initial: string
  onOk: (joined: string | undefined) => void
  onCancel: () => void
}

export function BatchSearchModal({ open, title, initial, onOk, onCancel }: Props) {
  const [text, setText] = useState(initial)
  const [seen, setSeen] = useState(initial)
  // 每次重新打开（initial 变了）就换成新的内容
  if (seen !== initial) {
    setSeen(initial)
    setText(initial)
  }
  const parsed = parseBatchTerms(text)
  const joined = joinBatchTerms(parsed.items)
  let problem: string | null = null
  if (parsed.items.length > BATCH_MAX_ITEMS) problem = `最多 ${BATCH_MAX_ITEMS} 个词，当前去重后有 ${parsed.items.length} 个，请删减后再提交`
  else if (parsed.tooLong.length > 0) problem = `有 ${parsed.tooLong.length} 个词超过 ${BATCH_ITEM_MAX} 个字符：${parsed.tooLong[0]!.slice(0, 20)}…`
  else if (parsed.overflow) problem = `总长度超过 ${BATCH_MAX_CHARS} 个字符，请分批搜索`

  return (
    <Modal
      open={open}
      title={title}
      okText={parsed.items.length === 0 ? '清除批量搜索' : '搜索'}
      cancelText="取消"
      okButtonProps={{ disabled: problem !== null }}
      onOk={() => onOk(parsed.items.length === 0 ? undefined : joined)}
      onCancel={onCancel}
      destroyOnHidden
      width={520}
    >
      <Input.TextArea aria-label="批量搜索内容" rows={9} value={text} placeholder="每行一个，也可以用逗号分隔；空行会被忽略，重复的只算一个" onChange={event => setText(event.target.value)} />
      <Typography.Paragraph type={problem ? 'danger' : 'secondary'} style={{ marginTop: 8, marginBottom: 0 }} role={problem ? 'alert' : undefined}>
        {problem ?? `共 ${parsed.items.length} 个词${parsed.duplicates > 0 ? `，已去掉 ${parsed.duplicates} 个重复` : ''}（精确匹配，最多 ${BATCH_MAX_ITEMS} 个）`}
      </Typography.Paragraph>
    </Modal>
  )
}
