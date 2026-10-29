import { useEffect } from 'react'

// 命令面板快捷键：Ctrl/⌘ + K。单独成文件，面板本身按需加载。
export function useCommandPaletteHotkey(open: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        open()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [open])
}
