import { SPLICE_POINT, type PacketTable } from './probe'

/**
 * A span of frames, half-open in display order. `first` and `last` are indexes
 * into PacketTable.displayOrder, `last` being exclusive.
 */
export interface EncodeSegment {
  kind: 'encode'
  first: number
  last: number
}

/**
 * Packets copied untouched: decode-order range [fromPacket, toPacket), less any
 * packet shown before the entry keyframe. Those are open-GOP leading frames that
 * reference the GOP we did not keep.
 */
export interface CopySegment {
  kind: 'copy'
  first: number
  last: number
  fromPacket: number
  toPacket: number
}

export type Segment = EncodeSegment | CopySegment

export interface CutPlan {
  /** Display-order frame range the output covers. */
  first: number
  last: number
  wantedFirst: number
  wantedLast: number
  segments: Segment[]
  frames: number
  reencodedFrames: number
}

/** Further than any codec reorders frames, and cheap to scan. */
const REORDER_WINDOW = 64

export function frameCount(segment: Segment): number {
  return segment.last - segment.first
}

/** Nearest display-order frame to a timeline time. */
export function frameAt(table: PacketTable, timelineSeconds: number): number {
  const order = table.displayOrder
  const target = order[0] + timelineSeconds
  let low = 0
  let high = order.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (order[middle] < target) low = middle + 1
    else high = middle
  }
  if (low > 0 && target - order[low - 1] <= order[low] - target) return low - 1
  return low
}

export function lowerBound(sorted: Float64Array, value: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle] < value) low = middle + 1
    else high = middle
  }
  return low
}

function makePlan(segments: Segment[], wantedFirst: number, wantedLast: number): CutPlan {
  return {
    first: segments[0].first,
    last: segments[segments.length - 1].last,
    wantedFirst,
    wantedLast,
    segments,
    frames: segments.reduce((sum, segment) => sum + frameCount(segment), 0),
    reencodedFrames: segments.reduce(
      (sum, segment) => sum + (segment.kind === 'encode' ? frameCount(segment) : 0),
      0
    )
  }
}

/** Packet indexes of the keyframes, in decode order. */
function keyPackets(table: PacketTable): number[] {
  const keys: number[] = []
  for (let i = 0; i < table.key.length; i += 1) if (table.key[i]) keys.push(i)
  return keys
}

/**
 * Pure stream copy. Nothing is re-encoded, so the output has to start on a
 * keyframe at or before the marked start, and run until every wanted frame has
 * the packets it needs.
 */
export function planCopy(table: PacketTable, wantedFirst: number, wantedLast: number): CutPlan {
  const order = table.displayOrder
  const keys = keyPackets(table)
  const startTime = order[wantedFirst]
  const endTime = wantedLast < order.length ? order[wantedLast] : Number.POSITIVE_INFINITY

  let entry = keys[0]
  for (const packet of keys) {
    if (table.pts[packet] <= startTime && table.pts[packet] >= table.pts[entry]) entry = packet
  }
  const entryPts = table.pts[entry]

  // The stop point is the packet after the last wanted one in decode order;
  // packets before it may show later than the mark but are needed as references.
  let toPacket = entry + 1
  for (let i = table.pts.length - 1; i >= entry; i -= 1) {
    if (table.pts[i] < endTime) {
      toPacket = i + 1
      break
    }
  }

  let lastShown = entryPts
  for (let i = entry; i < toPacket; i += 1) if (table.pts[i] > lastShown) lastShown = table.pts[i]
  // A kept reference frame may show after B-frames that decode later. Take those
  // too, or the clip would end with a jump over the missing frames.
  const horizon = Math.min(table.pts.length, toPacket + REORDER_WINDOW)
  for (let i = toPacket; i < horizon; i += 1) if (table.pts[i] < lastShown) toPacket = i + 1
  const first = lowerBound(order, entryPts)
  const last = lowerBound(order, lastShown) + 1
  return makePlan([{ kind: 'copy', first, last, fromPacket: entry, toPacket }], wantedFirst, wantedLast)
}

/**
 * Smart cut. Copies the keyframe-aligned middle of the clip and re-encodes only
 * the frames either side of it, so the output is frame exact with almost every
 * frame bit-identical to the rip.
 */
export function planSmart(table: PacketTable, wantedFirst: number, wantedLast: number): CutPlan {
  const order = table.displayOrder
  const startTime = order[wantedFirst]
  const endTime = wantedLast < order.length ? order[wantedLast] : Number.POSITIVE_INFINITY
  const keys = keyPackets(table)
    .filter((packet) => table.pts[packet] >= startTime)
    .sort((a, b) => table.pts[a] - table.pts[b])
  const entries = table.splicePointsMarked ? keys.filter((packet) => table.key[packet] === SPLICE_POINT) : keys

  const everything = (): CutPlan =>
    makePlan([{ kind: 'encode', first: wantedFirst, last: wantedLast }], wantedFirst, wantedLast)

  if (entries.length === 0) return everything()
  const entry = entries[0]
  const entryPts = table.pts[entry]
  if (entryPts >= endTime) return everything()

  // Choose the latest GOP boundary that keeps the end inside the clip. At the
  // end of the file there is no next keyframe, and the copy runs to the end.
  let exit = table.pts.length
  let bodyLastTime = Number.POSITIVE_INFINITY
  const reachesFileEnd = wantedLast === order.length
  if (!reachesFileEnd) {
    let chosen = -1
    for (const packet of keys) {
      if (packet > entry && table.pts[packet] <= endTime) chosen = packet
    }
    if (chosen === -1) return everything()
    exit = chosen
  }

  let lastShown = entryPts
  for (let i = entry; i < exit; i += 1) if (table.pts[i] > lastShown) lastShown = table.pts[i]
  bodyLastTime = lastShown

  // Open GOP: packets before the exit keyframe can be shown out of order, so the
  // frames kept must be contiguous in display order or the tail would have holes.
  const bodyFirst = lowerBound(order, entryPts)
  const shown = new Set<number>()
  for (let i = entry; i < exit; i += 1) if (table.pts[i] >= entryPts) shown.add(table.pts[i])
  let bodyLast = bodyFirst
  while (bodyLast < order.length && shown.has(order[bodyLast])) bodyLast += 1
  if (bodyLast === bodyFirst || order[bodyLast - 1] > bodyLastTime) return everything()

  const segments: Segment[] = []
  if (wantedFirst < bodyFirst) segments.push({ kind: 'encode', first: wantedFirst, last: bodyFirst })
  segments.push({ kind: 'copy', first: bodyFirst, last: bodyLast, fromPacket: entry, toPacket: exit })
  if (bodyLast < wantedLast) segments.push({ kind: 'encode', first: bodyLast, last: wantedLast })
  return makePlan(segments, wantedFirst, wantedLast)
}

export function planEncode(wantedFirst: number, wantedLast: number): CutPlan {
  return makePlan([{ kind: 'encode', first: wantedFirst, last: wantedLast }], wantedFirst, wantedLast)
}
