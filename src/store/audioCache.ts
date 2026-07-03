// Persistent cache for generated TTS audio. Because a play's non-actor lines
// are fixed, each line is synthesised once (by Kokoro or a premium engine) and
// then replays instantly and offline. Web Speech synthesis produces no blob and
// is spoken live, so it bypasses this cache.
//
// The cache is BOUNDED so it can never flood the device: we keep at most
// MAX_ENTRIES clips and MAX_BYTES total, evicting the oldest first (LRU-by-age).
// A tiny size index is kept in localStorage so we can bound by bytes without
// reading every blob back on each write.

const CACHE_NAME = 'understudy-audio-v1'
const INDEX_KEY = 'understudy-audio-index'
const MAX_ENTRIES = 400
const MAX_BYTES = 50 * 1024 * 1024 // 50 MB — plenty for many plays, safe on phones

const memFallback = new Map<string, Blob>()

interface IndexEntry {
  key: string
  size: number
}

function hasCacheAPI(): boolean {
  return typeof caches !== 'undefined'
}

function keyToUrl(key: string): string {
  return `https://understudy.audio/${encodeURIComponent(key)}`
}

// The index is held IN MEMORY (this module is a singleton) and persisted to
// localStorage only on writes/eviction — never on the read/playback hot path.
// A single in-memory array also removes read/write interleaving drift.
let memIndex: IndexEntry[] | null = null

function loadIndex(): IndexEntry[] {
  if (memIndex) return memIndex
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(INDEX_KEY) : null
    const parsed = raw ? (JSON.parse(raw) as IndexEntry[]) : []
    memIndex = Array.isArray(parsed) ? parsed : []
  } catch {
    memIndex = []
  }
  return memIndex
}

function saveIndex(index: IndexEntry[]): void {
  memIndex = index
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(INDEX_KEY, JSON.stringify(index))
  } catch {
    /* ignore quota/serialisation errors — the cache still self-bounds by count */
  }
}

export async function getCachedAudio(key: string): Promise<Blob | null> {
  if (!hasCacheAPI()) return memFallback.get(key) ?? null
  try {
    const cache = await caches.open(CACHE_NAME)
    const res = await cache.match(keyToUrl(key))
    if (res) touchIndex(key) // refresh recency so eviction is LRU, not FIFO
    return res ? await res.blob() : null
  } catch {
    return memFallback.get(key) ?? null
  }
}

/** Existence check WITHOUT refreshing recency — for prefetch probes, so that
 *  merely peeking at upcoming lines can't out-rank genuinely played audio in
 *  the LRU order. */
export async function hasCachedAudio(key: string): Promise<boolean> {
  if (!hasCacheAPI()) return memFallback.has(key)
  try {
    const cache = await caches.open(CACHE_NAME)
    return (await cache.match(keyToUrl(key))) !== undefined
  } catch {
    return memFallback.has(key)
  }
}

/** Move a key to the tail of the in-memory index (most recently used). The
 *  new order reaches localStorage with the next write — no I/O on reads. */
function touchIndex(key: string): void {
  const index = loadIndex()
  const at = index.findIndex((e) => e.key === key)
  if (at < 0 || at === index.length - 1) return
  const [entry] = index.splice(at, 1)
  index.push(entry)
}

export async function putCachedAudio(key: string, blob: Blob): Promise<void> {
  if (!hasCacheAPI()) {
    memFallback.set(key, blob)
    while (memFallback.size > MAX_ENTRIES) {
      const oldest = memFallback.keys().next().value
      if (oldest === undefined) break
      memFallback.delete(oldest)
    }
    return
  }
  try {
    const cache = await caches.open(CACHE_NAME)
    await cache.put(keyToUrl(key), new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/wav' } }))

    // Track size and evict oldest entries until back within both limits. The
    // SHARED in-memory index is mutated in place so concurrent puts/touches
    // interleave on one array instead of clobbering each other's copies.
    const index = loadIndex()
    const at = index.findIndex((e) => e.key === key)
    if (at >= 0) index.splice(at, 1)
    index.push({ key, size: blob.size })
    let total = index.reduce((n, e) => n + e.size, 0)
    while (index.length > MAX_ENTRIES || total > MAX_BYTES) {
      const evicted = index.shift()
      if (!evicted) break
      total -= evicted.size
      await cache.delete(keyToUrl(evicted.key))
    }
    saveIndex(index)
  } catch {
    memFallback.set(key, blob)
  }
}

/** Rough usage for display: number of cached clips and their total bytes. */
export async function audioCacheStats(): Promise<{ count: number; bytes: number }> {
  if (!hasCacheAPI()) {
    let bytes = 0
    for (const b of memFallback.values()) bytes += b.size
    return { count: memFallback.size, bytes }
  }
  const index = loadIndex()
  return { count: index.length, bytes: index.reduce((n, e) => n + e.size, 0) }
}

export async function clearAudioCache(): Promise<void> {
  memFallback.clear()
  saveIndex([])
  if (hasCacheAPI()) {
    try {
      await caches.delete(CACHE_NAME)
    } catch {
      /* ignore */
    }
  }
}
