const base = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'

export async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const payload = (response.headers.get('content-type') ?? '').includes('application/json') ? await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null : null
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
  return (payload?.data ?? {}) as T
}

export async function publicGet<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = await response.json() as { data?: T }
  return payload.data as T
}
