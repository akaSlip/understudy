import { useRef, useState } from 'react'
import type { Route } from '../App'
import type { Play } from '../types'
import { parseScript, toFountain } from '../lib/fountain'
import { extractText, isImage, isPdf, needsExtraction } from '../lib/ingest'
import { uid } from '../lib/util'
import { deletePlay, savePlay } from '../store/playsRepo'
import { useApp } from './useApp'

export function Library({ go }: { go: (r: Route) => void }) {
  const { plays, reloadPlays } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  async function onImportFile(file: File) {
    setImportError(null)
    try {
      setImporting(needsExtraction(file) ? 'Opening file…' : null)
      const text = await extractText(file, (p) => setImporting(p.message))
      const parsed = parseScript(text)
      const now = Date.now()
      const play: Play = {
        id: uid('p_'),
        title: parsed.title ?? file.name.replace(/\.[^.]+$/, ''),
        author: parsed.author,
        characters: parsed.characters,
        beats: parsed.beats,
        source: isPdf(file) || isImage(file) ? 'pdf' : 'fountain',
        createdAt: now,
        updatedAt: now,
      }
      await savePlay(play)
      await reloadPlays()
      go({ view: 'edit', playId: play.id })
    } catch (e) {
      setImportError(
        `Couldn't read “${file.name}”. ${e instanceof Error ? e.message : ''} If it's a scanned PDF or photo, OCR needs a connection the first time.`,
      )
    } finally {
      setImporting(null)
    }
  }

  function exportPlay(p: Play) {
    const text = toFountain(p)
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${p.title.replace(/[^\w-]+/g, '_')}.fountain`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function remove(p: Play) {
    if (!confirm(`Delete “${p.title}”? This can't be undone.`)) return
    await deletePlay(p.id)
    await reloadPlays()
  }

  return (
    <section className="library">
      <div className="section-head">
        <h1>Your plays</h1>
        <div className="actions">
          <button className="primary" onClick={() => go({ view: 'edit' })}>
            + New play
          </button>
          <button onClick={() => fileRef.current?.click()} disabled={!!importing}>
            {importing ? 'Reading…' : 'Import file'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".fountain,.txt,.md,text/plain,.pdf,application/pdf,image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onImportFile(f)
              e.target.value = ''
            }}
          />
        </div>
      </div>

      {importing && (
        <p className="import-status" role="status">
          <span className="spinner" aria-hidden="true" /> {importing}
        </p>
      )}
      {importError && (
        <p className="import-error" role="alert">
          {importError}
        </p>
      )}

      {plays.length === 0 && (
        <p className="muted">No plays yet. Create one, or import a .fountain / .txt / PDF script — or a photo or scan of a page.</p>
      )}

      <ul className="play-list">
        {plays.map((p) => {
          const lines = p.beats.filter((b) => b.kind === 'dialogue').length
          return (
            <li key={p.id} className="play-card">
              <div className="play-main">
                <h3>{p.title}</h3>
                <p className="muted">
                  {p.author ? `${p.author} · ` : ''}
                  {p.characters.length} characters · {lines} lines
                </p>
                <div className="chips">
                  {p.characters.slice(0, 8).map((c) => (
                    <span key={c.id} className="chip">
                      {c.name}
                    </span>
                  ))}
                </div>
              </div>
              <div className="play-actions">
                <button className="primary" onClick={() => go({ view: 'rehearse', playId: p.id })}>
                  Rehearse
                </button>
                <button onClick={() => go({ view: 'edit', playId: p.id })}>Edit</button>
                <button onClick={() => exportPlay(p)}>Export</button>
                <button className="danger" onClick={() => void remove(p)}>
                  Delete
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
