import type { Container, CutMethod, EncodePreset, MediaInfo, PacketSummary } from './types'

/** Long-GOP codecs we can re-encode the edges of and splice back in losslessly. */
export const SMART_CUT_CODECS = ['h264', 'hevc', 'mpeg2video'] as const

export const CONTAINER_LABELS: Record<Container, string> = {
  mkv: 'Matroska (.mkv)',
  mp4: 'MP4 (.mp4)',
  mov: 'QuickTime (.mov)',
  avi: 'AVI (.avi)',
  mpg: 'MPEG program stream (.mpg)'
}

const VIDEO_SUPPORT: Record<Container, readonly string[] | 'any'> = {
  mkv: 'any',
  mp4: ['h264', 'hevc', 'av1', 'vp9', 'mpeg2video', 'mpeg4'],
  mov: ['h264', 'hevc', 'mpeg2video', 'mpeg4', 'prores', 'dvvideo', 'mjpeg', 'rawvideo', 'dnxhd', 'qtrle'],
  avi: ['dvvideo', 'huffyuv', 'ffvhuff', 'ffv1', 'mjpeg', 'mpeg4', 'msmpeg4v3', 'rawvideo', 'utvideo'],
  mpg: ['mpeg2video', 'mpeg1video']
}

const AUDIO_SUPPORT: Record<Container, readonly string[] | 'any'> = {
  mkv: 'any',
  mp4: ['aac', 'mp3', 'ac3', 'eac3', 'alac', 'opus', 'mp2'],
  mov: ['aac', 'mp3', 'ac3', 'alac', 'pcm_s16le', 'pcm_s16be', 'pcm_s24le', 'pcm_s24be', 'pcm_f32le'],
  avi: ['pcm_s16le', 'pcm_s24le', 'mp3', 'ac3', 'mp2'],
  mpg: ['mp2', 'ac3', 'mp3']
}

/** Lossless target per container, used when audio cannot be copied as it is. */
export const AUDIO_FALLBACK: Record<Container, { codec: string; lossless: boolean }> = {
  mkv: { codec: 'flac', lossless: true },
  mp4: { codec: 'alac', lossless: true },
  mov: { codec: 'alac', lossless: true },
  avi: { codec: 'pcm_s16le', lossless: true },
  mpg: { codec: 'mp2', lossless: false }
}

export const ENCODE_PRESETS: Record<EncodePreset, { label: string; description: string; codec: string }> = {
  ffv1: {
    label: 'FFV1',
    description: 'Mathematically lossless archive format. Large files, MKV only for wide support.',
    codec: 'ffv1'
  },
  prores: {
    label: 'ProRes 422 HQ',
    description: 'Visually lossless and easy to edit, especially in Final Cut. Large files.',
    codec: 'prores'
  },
  h264: {
    label: 'H.264 (CRF 16)',
    description: 'Plays everywhere. High quality, but every frame is re-compressed.',
    codec: 'h264'
  },
  hevc: {
    label: 'H.265 (CRF 18)',
    description: 'Smaller than H.264 at similar quality. Every frame is re-compressed.',
    codec: 'hevc'
  }
}

export function supportsVideo(container: Container, codec: string): boolean {
  const support = VIDEO_SUPPORT[container]
  return support === 'any' || support.includes(codec)
}

export function supportsAudio(container: Container, codec: string): boolean {
  const support = AUDIO_SUPPORT[container]
  return support === 'any' || support.includes(codec)
}

export function containersFor(videoCodec: string): Container[] {
  return (['mkv', 'mp4', 'mov', 'avi', 'mpg'] as const).filter((c) => supportsVideo(c, videoCodec))
}

/** The rip's own container, when it is one we can write. */
export function sourceContainer(media: MediaInfo): Container | null {
  const names = media.container.split(',')
  if (names.includes('matroska')) return 'mkv'
  if (media.container === 'mov') return 'mov'
  if (names.includes('mp4')) return 'mp4'
  if (names.includes('avi')) return 'avi'
  if (names.includes('mpeg') || names.includes('vob')) return 'mpg'
  return null
}

export function defaultContainer(media: MediaInfo, method: CutMethod, preset: EncodePreset): Container {
  const codec = method === 'encode' ? ENCODE_PRESETS[preset].codec : media.video.codec
  const own = sourceContainer(media)
  if (own && supportsVideo(own, codec)) return own
  return containersFor(codec)[0]
}

export interface MethodOption {
  method: CutMethod
  label: string
  description: string
  recommended: boolean
}

export function methodsFor(media: MediaInfo, packets: PacketSummary | null): MethodOption[] {
  const intraOnly = packets?.intraOnly ?? false
  const smart = !intraOnly && (SMART_CUT_CODECS as readonly string[]).includes(media.video.codec)
  // Open-GOP H.264 has few keyframes a splice can start on, so smart cut would
  // re-encode nearly everything. It stays frame exact, but is not the better deal.
  const keyframes = packets?.keyframes.length ?? 0
  const smartIsCheap = smart && (packets?.spliceableKeyframes ?? 0) * 2 >= keyframes
  const methods: MethodOption[] = [
    {
      method: 'copy',
      label: 'Stream copy',
      description: intraOnly
        ? 'Every frame is copied untouched and cuts land exactly on your marks.'
        : 'Every frame is copied untouched, but clips must start on a keyframe, so each may begin slightly before your mark.',
      recommended: !smartIsCheap
    }
  ]
  if (smart) {
    methods.push({
      method: 'smart',
      label: 'Smart cut',
      description: smartIsCheap
        ? 'Cuts land exactly on your marks. Only the few frames between each mark and its nearest keyframe are re-encoded, at very high quality; the rest are copied untouched.'
        : 'Cuts land exactly on your marks, but this rip has few safe splice points, so most frames will be re-encoded, at very high quality.',
      recommended: smartIsCheap
    })
  }
  methods.push({
    method: 'encode',
    label: 'Re-encode',
    description: 'Converts the whole clip to a new format. Only use this if you need that format.',
    recommended: false
  })
  return methods
}
