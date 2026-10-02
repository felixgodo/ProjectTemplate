import { useEffect, useState, type FormEvent } from 'react'
import { api, type Note } from './api'

// Beispielseite: zeigt, dass Oberfläche, API und Datenbank zusammenspielen. Im echten Projekt ersetzen.
export function App() {
  const [version, setVersion] = useState<string | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .version()
      .then((v) => setVersion(v.version))
      .catch(() => setVersion(null))
    api
      .notes()
      .then(setNotes)
      .catch((e: Error) => setError(e.message))
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!text.trim()) return
    try {
      const note = await api.addNote(text)
      setNotes((current) => [note, ...current])
      setText('')
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-2xl font-semibold">ProjectTemplate</h1>
      <p className="mt-1 text-sm opacity-70">
        Backend: {version ? `Version ${version}` : 'nicht erreichbar'}
      </p>

      <form onSubmit={submit} className="mt-8 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          placeholder="Notiz"
          aria-label="Notiz"
          className="min-w-0 flex-1 rounded border border-current/30 bg-transparent px-3 py-2"
        />
        <button type="submit" className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700">
          Speichern
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-600">Fehler: {error}</p>}

      <ul className="mt-6 space-y-2">
        {notes.map((note) => (
          <li key={note.id} className="rounded border border-current/15 px-3 py-2">
            {note.text}
            <span className="ml-2 text-xs opacity-60">{new Date(note.createdAt).toLocaleString('de-DE')}</span>
          </li>
        ))}
      </ul>
    </main>
  )
}
