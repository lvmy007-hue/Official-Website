import type { ReactNode } from 'react'

// 仪表盘左侧文件夹树（P6-33）。共享的仪表盘不放进别人的文件夹。

export interface FolderNode {
  id: string
  parentId: string | null
  name: string
  version: number
}

export interface DashCard {
  id: string
  name: string
  folderId: string | null
  shared: boolean
}

export function DashboardTree(props: { folders: FolderNode[]; selected: string | null; onSelect: (id: string | null) => void; extra?: ReactNode }) {
  const roots = props.folders.filter(folder => folder.parentId === null)
  const children = (id: string) => props.folders.filter(folder => folder.parentId === id)
  const render = (folder: FolderNode, depth: number) => (
    <div key={folder.id}>
      <button type="button" aria-current={props.selected === folder.id ? 'true' : undefined} onClick={() => props.onSelect(folder.id)} style={{ paddingLeft: depth * 12 }}>
        {folder.name}
      </button>
      {children(folder.id).map(child => render(child, depth + 1))}
    </div>
  )
  return (
    <nav aria-label="文件夹" data-testid="dashboard-tree" style={{ minWidth: 160 }}>
      <button type="button" aria-current={props.selected === null ? 'true' : undefined} onClick={() => props.onSelect(null)}>
        全部
      </button>
      {roots.map(folder => render(folder, 1))}
      {props.extra}
    </nav>
  )
}
