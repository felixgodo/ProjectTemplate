// Immer relativ zu /api: in der Entwicklung leitet der Vite-Proxy weiter, im Betrieb nginx.

export interface Note {
  id: number
  text: string
  createdAt: string
}

export interface Version {
  name: string
  version: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}

export const api = {
  version: () => request<Version>('/version'),
  notes: () => request<Note[]>('/notes'),
  addNote: (text: string) => request<Note>('/notes', { method: 'POST', body: JSON.stringify({ text }) }),
}
