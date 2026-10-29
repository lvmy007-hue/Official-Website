export function isWorkspacePath(path: string) {
  return path === '/login' || path === '/app' || path.startsWith('/app/') || path.startsWith('/platform/') || path.startsWith('/invite/')
}
