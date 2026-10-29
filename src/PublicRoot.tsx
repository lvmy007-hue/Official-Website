import { useEffect, useState } from 'react'
import { ProductionWebsite } from './ProductionWebsite'
import { websitePageFromPath } from './public-site-content'
import { isWorkspacePath } from './route-kind'

export function PublicRoot({ initialPath }: { initialPath: string }) {
  const [path, setPath] = useState(initialPath)
  useEffect(() => {
    const listener = () => {
      const next = window.location.pathname || '/'
      if (isWorkspacePath(next)) { window.location.assign(next); return }
      setPath(next)
    }
    window.addEventListener('popstate', listener)
    return () => window.removeEventListener('popstate', listener)
  }, [])
  return <ProductionWebsite page={websitePageFromPath(path) ?? 'not-found'} />
}
