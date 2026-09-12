/**
 * dsh-auto-continue repair half: scan a session log and, when it carries
 * duplicate/overlapping records (the signature of two drivers appending the
 * same event range — the corruption this plugin exists to heal), rebuild the
 * file keeping every unique event. A true seq gap (events genuinely missing)
 * is left for a human: repairing it would fabricate history.
 *
 * Zstandard support comes from `node:zlib` (Node 22+), the same engine the
 * harness persistence backend uses; frame scanning is a faithful port of the
 * backend's structural scanner so the output is accepted by the same reader.
 */

import { zstdCompress, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

/**
 * `decodeStorageRecord` turns one stored JSONL row into its event list. The
 * harness moved it between packages across pre-release versions (it is no
 * longer exported from `dsh-session` in 0.1.3-alpha.2), so the lookup is
 * dynamic; when neither package exports it the repair feature degrades to
 * "unsupported" instead of breaking the whole plugin import.
 */
let decodeStorageRecord
for (const specifier of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-format']) {
  try {
    const mod = await import(specifier)
    if (typeof mod.decodeStorageRecord === 'function') {
      decodeStorageRecord = mod.decodeStorageRecord
      break
    }
  } catch {
    /* try the next candidate package */
  }
}

/** Whether the running harness exposes the storage-record decoder. */
export const repairSupported = typeof decodeStorageRecord === 'function'

const compressAsync = promisify(zstdCompress)
const decompressAsync = promisify(zstdDecompress)

const ZSTD_MAGIC = 0xfd2fb528

/**
 * Structural zstd frame scan, ported from the harness persistence backend.
 * @param buffer - complete artifact bytes.
 * @param maxFrames - optional complete-frame cap.
 * @returns complete frame ranges plus an optional incomplete-final-frame start.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** Decompress every complete frame in a concatenated zstd artifact. */
export async function decodeAllFrames(raw) {
  const scan = scanZstdFrames(raw)
  const texts = []
  for (const frame of scan.frames) {
    const plain = await decompressAsync(raw.subarray(frame.start, frame.end))
    texts.push(plain.toString('utf8'))
  }
  return { scan, texts }
}

/**
 * Rebuild a session log's records: drop duplicate rows, trim overlapping
 * anchored-chunk records to their unique tail, keep every unique event.
 * @param lines - all JSONL lines (unfiltered, in file order).
 * @returns a rebuild report; `status` is 'ok' (no change), 'repaired', or
 * 'gap' (a true seq hole — never auto-fixed).
 */
export function repairLines(lines) {
  if (typeof decodeStorageRecord !== 'function') {
    return { status: 'unsupported', reason: 'decodeStorageRecord is not exported by this harness build' }
  }
  const header = lines.find((l) => l.includes('"type":"session"'))
  if (header === undefined) return { status: 'gap', reason: 'no session header' }
  const output = [header]
  let count = 0
  const repairs = []
  for (const line of lines) {
    if (line === header) continue
    let decoded = []
    try {
      const rec = JSON.parse(line)
      if (rec.type === 'session') {
        output.push(line)
        continue
      }
      decoded = decodeStorageRecord(rec)
    } catch {
      repairs.push({ kind: 'unparsable' })
      continue
    }
    if (!Array.isArray(decoded) || decoded.length === 0) {
      output.push(line)
      continue
    }
    const firstSeq = decoded[0].seq
    if (typeof firstSeq === 'number' && firstSeq === count) {
      for (const ev of decoded) count += 1
      output.push(line)
      continue
    }
    if (typeof firstSeq === 'number' && firstSeq < count) {
      const overlap = count - firstSeq
      if (overlap >= decoded.length) {
        repairs.push({ kind: 'dup-record', seq: firstSeq, dropped: decoded.length })
        continue
      }
      const rec = JSON.parse(line)
      if (typeof rec.seq0 === 'number' && Array.isArray(rec.data?.dt)) {
        const chunkField = Array.isArray(rec.data?.texts) ? 'texts' : (Array.isArray(rec.data?.args) ? 'args' : undefined)
        if (chunkField !== undefined) {
          const dt = rec.data.dt.slice(overlap)
          const chunks = rec.data[chunkField].slice(overlap)
          const timeShift = rec.data.dt.slice(0, overlap).reduce((a, b) => a + b, 0)
          rec.seq0 += overlap
          rec.time0 += timeShift
          rec.data.dt = dt
          rec.data[chunkField] = chunks
          const rebuilt = JSON.stringify(rec)
          const redecoded = decodeStorageRecord(JSON.parse(rebuilt))
          if (redecoded.some((ev, i) => ev.seq !== count + i)) {
            return { status: 'gap', reason: `rebuild inconsistent at seq ${count}` }
          }
          for (const ev of redecoded) count += 1
          output.push(rebuilt)
          repairs.push({ kind: 'trim-overlap', seq: firstSeq, overlap, kept: redecoded.length })
          continue
        }
      }
      repairs.push({ kind: 'dup-plain', seq: firstSeq, dropped: decoded.length })
      continue
    }
    return { status: 'gap', reason: `seq hole at ${count} (got ${firstSeq})`, repairs }
  }
  const healed = healInboxSplices(output, repairs)
  if (repairs.length === 0) return { status: 'ok', events: count, repairs, lines: healed }
  return { status: 'repaired', events: count, repairs, lines: healed }
}

/**
 * Replay the agent inbox projection over the rebuilt lines and neutralize
 * splices that no longer apply — e.g. a delete splice whose inserted messages
 * were lost to a concurrent writer. A splice is replaced by a legal no-op
 * splice (same target, nothing removed, nothing inserted) so the event count
 * and seq numbering stay intact.
 * @param lines - rebuilt lines (header first).
 * @param repairs - repair report to extend.
 * @returns lines with invalid splices neutralized.
 */
function healInboxSplices(lines, repairs) {
  const state = { 'next-turn': [], 'next-step': [] }
  const out = []
  for (const line of lines) {
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      out.push(line)
      continue
    }
    if (rec.type !== 'agent/inbox/spliced') {
      out.push(line)
      continue
    }
    const d = rec.data ?? {}
    const inbox = state[d.target]
    const removedCount = d.removedCount ?? 0
    const validRange = Number.isSafeInteger(d.start) && d.start >= 0 && d.start <= inbox.length
      && Number.isSafeInteger(removedCount) && removedCount >= 0
      && d.start + removedCount <= inbox.length
    const candidate = validRange ? [...inbox] : null
    if (candidate !== null) candidate.splice(d.start, removedCount, ...(d.inserted ?? []))
    const ids = new Set()
    let dup = false
    if (candidate !== null) {
      for (const m of d.target === 'next-turn' ? [...candidate, ...state['next-step']] : [...state['next-turn'], ...candidate]) {
        if (ids.has(m.id)) { dup = true; break }
        ids.add(m.id)
      }
    }
    if (candidate === null || dup) {
      repairs.push({ kind: 'inbox-splice-neutralized', seq: rec.seq, target: d.target, start: d.start, removedCount })
      rec.data = { target: d.target, start: 0, inserted: [] }
      out.push(JSON.stringify(rec))
      continue
    }
    state[d.target] = candidate
    out.push(line)
  }
  return out
}

/**
 * Repair one session artifact in place (atomic tmp + rename), keeping a
 * backup of the pre-repair bytes beside it.
 * @param file - path to `session.jsonl.zstd`.
 * @returns the repair report.
 */
export async function repairSessionFile(file) {
  const raw = readFileSync(file)
  let texts
  try {
    texts = await decodeAllFrames(raw)
  } catch (error) {
    return { status: 'error', reason: String(error?.message ?? error) }
  }
  const lines = []
  for (const t of texts.texts) {
    for (const l of t.split('\n')) lines.push(l)
  }
  const report = repairLines(lines)
  if (report.status !== 'repaired') return report
  const frames = []
  const repairedLines = report.lines
  frames.push(await compressAsync(Buffer.from(repairedLines[0] + '\n', 'utf8')))
  const rest = repairedLines.slice(1)
  for (let i = 0; i < rest.length; i += 200) {
    frames.push(await compressAsync(Buffer.from(rest.slice(i, i + 200).join('\n') + '\n', 'utf8')))
  }
  const out = Buffer.concat(frames)
  const backup = `${file}.bak-auto`
  try {
    statSync(backup)
    renameSync(backup, `${backup}.old`)
  } catch {
    /* no previous backup */
  }
  renameSync(file, backup)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, out)
  renameSync(tmp, file)
  report.backup = backup
  return report
}
