import { useState, type Key, type ReactNode } from 'react'
import { Drawer } from 'antd'

// 行详情抽屉（P6-28）：原 antd 表“点行展开子内容”的替代。表格 onRowOpen 记下行，抽屉里画原来的展开内容；
// 行以 rowKey 记，数据重新读取后仍取最新那一行，行不在了抽屉自动合上。

export type RowDetailDrawerProps<T> = {
  rows: readonly T[] | undefined
  rowKey: (row: T) => Key
  openKey: Key | null
  onClose: () => void
  title: (row: T) => ReactNode
  children: (row: T) => ReactNode
  width?: number
}

export function useRowDetail() {
  const [openKey, setOpenKey] = useState<Key | null>(null)
  return { openKey, open: (key: Key) => setOpenKey(key), close: () => setOpenKey(null) }
}

export function RowDetailDrawer<T>({ rows, rowKey, openKey, onClose, title, children, width = 760 }: RowDetailDrawerProps<T>) {
  const row = openKey === null ? undefined : rows?.find(item => rowKey(item) === openKey)
  return (
    <Drawer open={row !== undefined} onClose={onClose} width={width} title={row ? title(row) : null} destroyOnClose>
      {row ? children(row) : null}
    </Drawer>
  )
}
