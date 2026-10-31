import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Place } from '../shared/types'

const TIMEOUT_MS = 15_000

/** The Maps service is only asked once for each place name. */
const cache = new Map<string, Place[]>()

function ask(helper: string, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(helper, [query], { timeout: TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(new Error('The place lookup failed.'))
      else resolve(stdout)
    })
  })
}

export async function searchPlaces(helper: string, query: string): Promise<Place[]> {
  const key = query.trim().toLowerCase()
  const known = cache.get(key)
  if (known) return known
  if (!existsSync(helper)) throw new Error('Place lookups need Xcode tools: run xcode-select --install, then restart.')
  const result = JSON.parse(await ask(helper, query.trim())) as { matches?: Place[]; error?: string }
  if (!result.matches) throw new Error(result.error ?? 'The place lookup failed.')
  cache.set(key, result.matches)
  return result.matches
}
