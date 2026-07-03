// ---------------------------------------------------------------------------
// Document ingest: turn a dropped file into script text.
// ---------------------------------------------------------------------------
// - Plain text (.txt/.fountain/.md) is read directly.
// - PDFs: embedded text is extracted with pdf.js (fully offline). A page with
//   little or no text is treated as a scan and sent to OCR.
// - Images (photos / scans of a page) go straight to OCR.
//
// pdf.js and Tesseract are heavy, so they're dynamically imported — they only
// load when a PDF/image is actually imported, and Tesseract fetches its engine
// + language data from the CDN on first OCR (≈12 MB, then browser-cached).

import type { PDFPageProxy } from 'pdfjs-dist'

export interface IngestProgress {
  stage: 'reading' | 'ocr' | 'done'
  page?: number
  pages?: number
  /** 0..1 for the current sub-task, when known. */
  pct?: number
  message: string
}
export type ProgressFn = (p: IngestProgress) => void

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}
export function isImage(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.name)
}
/** True for anything we can turn into text here (else caller uses file.text()). */
export function needsExtraction(file: File): boolean {
  return isPdf(file) || isImage(file)
}

/** Extract script text from any supported file. Edition-apparatus cleanup runs
 *  here, on the shared exit, so PDFs, photographed pages AND pasted text files
 *  from the same source all get the same treatment; OCR output additionally
 *  gets script-shaping (speaker cues onto their own lines, hyphen repair …). */
export async function extractText(file: File, onProgress?: ProgressFn): Promise<string> {
  if (isPdf(file)) {
    const { text, ocred } = await extractPdfRaw(file, onProgress)
    const cleaned = cleanEditionArtifacts(text)
    return ocred ? shapeOcrScript(cleaned) : cleaned
  }
  if (isImage(file)) return shapeOcrScript(cleanEditionArtifacts(await extractImage(file, onProgress)))
  return cleanEditionArtifacts(await file.text())
}

// --- PDF -------------------------------------------------------------------

async function extractPdfRaw(file: File, onProgress?: ProgressFn): Promise<{ text: string; ocred: boolean }> {
  const pdfjs = await import('pdfjs-dist')
  // Vite resolves this to a hashed worker asset at build time.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString()

  const data = new Uint8Array(await file.arrayBuffer())
  const doc = await pdfjs.getDocument({ data }).promise
  const pages: string[] = []
  let ocrError: unknown = null
  let ocred = false
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress?.({ stage: 'reading', page: n, pages: doc.numPages, message: `Reading page ${n} of ${doc.numPages}…` })
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      let text = reconstructLines(content.items as TextItem[])
      if (text.replace(/\s/g, '').length < 8) {
        // No embedded text — this page is probably a scan (or a cover image);
        // try OCR, but never let one bad page kill a PDF whose OTHER pages have
        // perfectly good selectable text.
        onProgress?.({ stage: 'ocr', page: n, pages: doc.numPages, message: `Page ${n} looks scanned — running OCR…` })
        try {
          text = await ocrPdfPage(page, onProgress, n, doc.numPages)
          ocred = true
        } catch (e) {
          ocrError = e
          text = ''
        }
      }
      pages.push(text)
    }
  } finally {
    await doc.destroy()
  }
  const combined = pages.join('\n\n')
  // Only fail the import when OCR was the ONLY possible source of text.
  if (ocrError && !combined.trim()) throw ocrError instanceof Error ? ocrError : new Error(String(ocrError))
  onProgress?.({ stage: 'done', message: 'Finished reading.' })
  return { text: combined, ocred }
}

/** Strip scholarly-edition apparatus that would pollute line scoring. Folger
 *  PDFs (the most common free Shakespeare source) prefix every line with
 *  "FTLN 1234" and put margin line numbers at line ends — an actor would be
 *  marked wrong for not saying them. EVERY rule is gated on the document
 *  carrying the FTLN signature, so ordinary scripts pass through untouched. */
export function cleanEditionArtifacts(text: string): string {
  // OCR misreads FTLN many ways: FILN, F1LN, FTN, FLN …
  const ftln = /^\s*F[TIL1l]{0,3}N\s*\d+\s*/
  const lines = text.split('\n')
  const isFolger = lines.filter((l) => ftln.test(l)).length >= 3
  if (!isFolger) return text
  return lines
    .map((raw) => {
      const l = raw.replace(ftln, '').replace(/\s+\d{1,4}$/, '') // prefix + margin number
      // A line that is only a number (page number) says nothing worth keeping.
      if (/^\s*\d{1,4}\s*$/.test(l)) return ''
      // Running page headers: "101 Macbeth ACT 3. SC. 4" (often OCR-mangled).
      if (/^\s*\d{1,4}\s+\p{Lu}\p{Ll}+/u.test(l)) return ''
      return l
    })
    .join('\n')
}

/** Shape raw OCR text into parseable script layout. OCR flattens the visual
 *  structure a parser needs: speaker names end up INLINE with their first line
 *  ("| MACBETH Thanks for that." — the "|" is Folger's shared-verse indent),
 *  hyphenated line breaks split words, and stage directions glue onto speech.
 *  Applied ONLY to OCR output — typed text is never reshaped. */
export function shapeOcrScript(text: string): string {
  let t = text.replace(/\r/g, '')
  // Rejoin words hyphenated across a line break ("con-\ntinued").
  t = t.replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2')
  // OCR quote/apostrophe repairs: curly quotes, ° and * misread for apostrophes.
  t = t.replace(/(\p{L})”(?=\s|$)/gu, "$1'") // th” present → th' present (before quote mapping)
  t = t.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/°/g, "'")
  t = t.replace(/(^|\s)\*(?=\p{L})/gu, "$1'")

  // A speaker cue: 1–4 ALL-CAPS words (first ≥2 letters), optional comma, an
  // optional (performance cue), then optionally the first words of the speech.
  const CUE = /^((?:\p{Lu}[\p{Lu}'’-]+)(?:\s+(?:\p{Lu}[\p{Lu}'’-]+|OF|THE|AND)){0,3}),?\s*(\([^)]*\))?\s*(.*)$/u
  const HEADING = /^(ACT|SCENE|PROLOGUE|EPILOGUE)\b/
  const STAGE = /^(Enter|Exit|Exeunt|Re-enter|Alarum|Flourish|Thunder)\b/
  // Caps words that start sentences far more often than they name a speaker.
  const OCR_STOPWORDS = new Set([
    'A', 'AN', 'AND', 'AY', 'BE', 'BUT', 'DO', 'FOR', 'GO', 'HE', 'HOW', 'IF', 'IN', 'IS', 'IT', 'LET', 'MY',
    'NO', 'NOT', 'NOW', 'OF', 'ON', 'OR', 'OUR', 'SHE', 'SO', 'THAT', 'THE', 'THEN', 'THERE', 'THEY', 'THIS',
    'TO', 'US', 'WE', 'WHAT', 'WHERE', 'WHO', 'WHY', 'YE', 'YES', 'YOU',
  ])

  const out: string[] = []
  for (const raw of t.split('\n')) {
    // Folger's shared-verse marker: "| MACBETH Thanks for that."
    const line = raw.replace(/^\s*\|\s*/, '').trimEnd()
    if (!line.trim()) {
      out.push('')
      continue
    }
    // Stage directions get their own paragraph so they parse as action beats.
    if (STAGE.test(line.trim())) {
      out.push('', line.trim(), '')
      continue
    }
    // Trailing inline exit glued to a speech: "…again. Murderer exits."
    const exit = line.match(/^(.*[.!?])\s+((?:They|[A-Z]\w+(?:\s+\w+){0,3})\s+exi(?:t|ts)\.)$/)
    if (exit) {
      out.push(exit[1], '', exit[2], '')
      continue
    }
    const m = line.match(CUE)
    if (m && !HEADING.test(m[1])) {
      const name = m[1].replace(/,+$/, '')
      const cue = m[2]
      const rest = m[3]?.trim()
      const words = name.split(/\s+/)
      // Guards against false positives:
      // - speech text after the name must start like a sentence (capital/quote);
      // - a lone caps stop-word starting a sentence ("TO saucy doubts…") is text;
      // - a fully-shouted line ("STOP THAT NOW.") is text, not name + speech.
      const restOk = !rest || /^[\p{Lu}"'‘’]/u.test(rest)
      const stopWord = words.length === 1 && !cue && !!rest && OCR_STOPWORDS.has(words[0])
      const shouted = !!rest && rest.length > 3 && !/\p{Ll}/u.test(rest)
      if (restOk && !stopWord && !shouted) {
        out.push('', name)
        if (cue) out.push(cue)
        if (rest) out.push(rest)
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export interface TextItem {
  str: string
  transform: number[] // [a, b, c, d, x, y]
  height?: number
}

/** Rebuild line breaks from positioned text items: group by baseline (y),
 *  order each row left→right, and insert a blank line where the vertical gap is
 *  noticeably larger than the usual line spacing (a paragraph / speech break). */
export function reconstructLines(items: TextItem[]): string {
  const rows = new Map<number, { x: number; str: string }[]>()
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue
    const y = Math.round(it.transform[5])
    const arr = rows.get(y) ?? []
    arr.push({ x: it.transform[4], str: it.str })
    rows.set(y, arr)
  }
  const ys = [...rows.keys()].sort((a, b) => b - a) // top of page first
  if (!ys.length) return ''

  // Baseline = the lower-quartile row gap (the tight line spacing within a
  // paragraph); a gap noticeably bigger than that marks a paragraph/speech break.
  const gaps: number[] = []
  for (let i = 1; i < ys.length; i++) gaps.push(ys[i - 1] - ys[i])
  const sorted = [...gaps].sort((a, b) => a - b)
  const base = sorted.length ? sorted[Math.floor(sorted.length * 0.25)] : 0
  const paraGap = base > 0 ? base * 1.5 : Infinity

  const lines: string[] = []
  let prevY: number | null = null
  for (const y of ys) {
    if (prevY !== null && prevY - y > paraGap) lines.push('')
    const row = rows
      .get(y)!
      .sort((a, b) => a.x - b.x)
      .map((r) => r.str)
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    if (row) lines.push(row)
    prevY = y
  }
  return lines.join('\n')
}

// --- OCR (Tesseract) -------------------------------------------------------

async function extractImage(file: File, onProgress?: ProgressFn): Promise<string> {
  onProgress?.({ stage: 'ocr', message: 'Reading image — running OCR…' })
  const text = await ocr(file, onProgress)
  onProgress?.({ stage: 'done', message: 'Finished reading.' })
  return text
}

async function ocrPdfPage(page: PDFPageProxy, onProgress: ProgressFn | undefined, n: number, total: number): Promise<string> {
  const viewport = page.getViewport({ scale: 2 })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const canvasContext = canvas.getContext('2d')
  if (!canvasContext) throw new Error('Could not create a canvas for OCR.')
  await page.render({ canvasContext, viewport }).promise
  return ocr(canvas, (p) =>
    onProgress?.({ ...p, page: n, pages: total, message: `OCR page ${n} of ${total}… ${p.pct != null ? Math.round(p.pct * 100) + '%' : ''}` }),
  )
}

// Minimal shape of Tesseract.recognize we rely on.
type Recognize = (
  image: unknown,
  lang: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts: { logger?: (m: any) => void },
) => Promise<{ data: { text: string } }>

async function ocr(image: unknown, onProgress?: ProgressFn): Promise<string> {
  const mod = (await import('tesseract.js')) as unknown as {
    recognize?: Recognize
    default?: { recognize: Recognize }
  }
  const recognize = mod.recognize ?? mod.default?.recognize
  if (!recognize) throw new Error('OCR engine failed to load.')
  const result = await recognize(image, 'eng', {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: (m: any) => {
      if (m.status === 'recognizing text') {
        onProgress?.({ stage: 'ocr', pct: m.progress, message: `Recognising text… ${Math.round(m.progress * 100)}%` })
      }
    },
  })
  return result.data.text
}
