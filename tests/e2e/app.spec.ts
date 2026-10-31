import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const SCREENSHOTS = process.env.SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), 'shots-'))
mkdirSync(SCREENSHOTS, { recursive: true })

/** A fake tape: three distinct recordings, interlaced, in a container Chromium can't play. */
function makeTape(directory: string, name: string, codecArgs: string[]): string {
  const path = join(directory, name)
  const scene = (source: string): string => `${source}=s=720x576:r=50:d=8,format=yuv420p,setsar=16/15`
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', scene('testsrc2'),
    '-f', 'lavfi', '-i', scene('smptebars'),
    '-f', 'lavfi', '-i', scene('rgbtestsrc'),
    '-f', 'lavfi', '-i', 'anoisesrc=r=48000:d=24:a=0.2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,tinterlace=interleave_top[v]',
    '-map', '[v]', '-map', '3:a', ...codecArgs, path
  ])
  return path
}

/** Native dialogs can't be driven, so they answer as if the user had chosen these. */
async function stubDialogs(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
  }, paths)
}

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  // A stand-in for Apple Maps, so these tests are repeatable and offline.
  const env = { ...process.env, MME_USER_DATA: userData, MME_PLACES_HELPER: join(__dirname, 'fake-places.sh') }
  const app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.error('pageerror', error))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('console', message.text())
  })
  await page.waitForSelector('#root > *')
  return { app, page }
}

test('imports a rip, marks and tags clips, and exports them', async () => {
  const work = mkdtempSync(join(tmpdir(), 'mme-e2e-'))
  const output = join(work, 'exports')
  const tape = makeTape(work, 'Tape 07 Holidays.mkv', [
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-g', '50',
    '-flags', '+ildct+ilme', '-x264opts', 'tff=1', '-c:a', 'pcm_s16le'
  ])

  const userData = join(work, 'user-data')
  let { app, page } = await launch(userData)
  await expect(page.getByText('Drop your tape rips here')).toBeVisible()
  await page.screenshot({ path: join(SCREENSHOTS, '01-welcome.png') })

  await stubDialogs(app, [tape])
  await page.getByRole('button', { name: 'Add Rips…' }).click()
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Tape 07 Holidays')
  await page.screenshot({ path: join(SCREENSHOTS, '02-preparing.png') })

  const video = page.locator('video')
  await expect(video).toBeVisible({ timeout: 120_000 })
  await page.waitForFunction(() => {
    const element = document.querySelector('video')
    return element !== null && element.readyState >= 2
  })
  await expect(page.locator('.project-job')).toHaveCount(0, { timeout: 120_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(SCREENSHOTS, '03-ready.png') })

  const timecode = page.getByTestId('timecode')

  // Frame stepping lands on the exact frame.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(timecode).toHaveText('0:00:00:02')
  await page.keyboard.press('ArrowLeft')
  await expect(timecode).toHaveText('0:00:00:01')

  // Scene detection found the two joins between recordings.
  await page.keyboard.press('n')
  await expect(timecode).toHaveText('0:00:08:00')
  await page.keyboard.press('n')
  await expect(timecode).toHaveText('0:00:16:00')
  await page.keyboard.press('Shift+N')
  await expect(timecode).toHaveText('0:00:08:00')

  // First clip: the first recording, 1s to just before the join.
  await page.keyboard.press('Shift+N')
  await page.keyboard.press('Shift+N')
  await page.keyboard.press('Shift+ArrowRight')
  await expect(timecode).toHaveText('0:00:01:00')
  await page.keyboard.press('i')
  await page.keyboard.press('n')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.screenshot({ path: join(SCREENSHOTS, '04-marking.png') })
  await page.keyboard.press('o')
  await expect(page.getByTestId('clip-row')).toHaveCount(1)

  // Tag it.
  await page.keyboard.press('Enter')
  await page.keyboard.type('Christmas morning')
  await page.keyboard.press('Enter')
  await page.getByRole('textbox', { name: 'Date', exact: true }).fill('1994-12-25')

  // A personal place can match an unrelated business, so nothing saves unconfirmed.
  const location = page.getByRole('combobox', { name: 'Location' })
  await location.fill("Grandma's house")
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /Sandy, OR/ })).toBeVisible()
  await expect(page.getByTestId('place-pin')).toHaveCount(0)
  await page.getByRole('button', { name: 'None of these: keep as text only' }).click()
  await expect(location).toHaveValue("Grandma's house")
  await expect(page.getByTestId('place-pin')).toHaveCount(0)

  // A real place: confirming with Enter saves its coordinates and time zone.
  await location.fill('Butternut, WI')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /Butternut, WI, United States/ })).toBeFocused()
  await page.screenshot({ path: join(SCREENSHOTS, '05a-place-match.png') })
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('place-pin')).toContainText('46.0131, -90.4966')
  await expect(page.getByRole('combobox', { name: 'Time zone' })).toHaveValue('America/Chicago')
  await expect(page.getByText('UTC-06:00 on this date')).toBeVisible()
  await page.getByRole('textbox', { name: 'Time', exact: true }).fill('09:30')

  await page.getByRole('combobox', { name: 'People' }).fill('Mum')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Dad,')
  await page.getByRole('textbox', { name: 'Notes' }).click()
  await page.keyboard.press('Escape')

  // Second clip: the second recording, on exact frames either side of the join.
  await page.keyboard.press('Escape')
  await page.keyboard.press('n')
  await expect(timecode).toHaveText('0:00:08:00')
  await page.keyboard.press('i')
  await page.keyboard.press('n')
  await page.keyboard.press('o')
  await expect(page.getByTestId('clip-row')).toHaveCount(2)
  await page.keyboard.press('Enter')
  await page.keyboard.type('New Years party')
  await page.keyboard.press('Enter')

  // A confirmed name fills in with no lookup and no second confirmation.
  await page.waitForTimeout(500)
  await location.fill('butternut, wi')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('place-pin')).toContainText('46.0131, -90.4966')
  await expect(page.locator('.place-matches')).toHaveCount(0)

  // A POI works the same, and typing over it clears the old pin and time zone.
  await location.fill('Walt Disney World')
  await expect(page.getByTestId('place-pin')).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Time zone' })).toHaveValue('')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /N World Dr/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('place-pin')).toContainText('28.3802, -81.5612')
  await expect(page.getByRole('combobox', { name: 'Time zone' })).toHaveValue('America/New_York')

  await page.getByRole('button', { name: 'Copy tags from previous clip' }).click()
  await expect(page.getByRole('textbox', { name: 'Date', exact: true })).toHaveValue('1994-12-25')
  await expect(page.getByTestId('place-pin')).toContainText('46.0131, -90.4966')
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SCREENSHOTS, '05-tagged.png') })

  // Undo and redo removal of a clip.
  await page.getByRole('textbox', { name: 'Date', exact: true }).fill('1995-01-01')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('clip-row')).toHaveCount(1)
  await page.keyboard.press('Meta+z')
  await expect(page.getByTestId('clip-row')).toHaveCount(2)

  // The shortcut sheet opens and closes.
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await page.screenshot({ path: join(SCREENSHOTS, '06-shortcuts.png') })
  await page.keyboard.press('Escape')

  await stubDialogs(app, [output])
  await page.keyboard.press('e')
  const dialog = page.getByRole('dialog', { name: 'Export clips' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/Exact ·/).first()).toBeVisible()
  await dialog.getByRole('button', { name: 'Choose folder…' }).click()
  await expect(dialog.getByRole('button', { name: output })).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(SCREENSHOTS, '07-export-dialog.png') })
  await dialog.getByRole('button', { name: 'Export 2 clips' }).click()
  await expect(page.getByTestId('export-progress').locator('.done')).toHaveCount(2, { timeout: 120_000 })
  await page.screenshot({ path: join(SCREENSHOTS, '08-export-done.png') })
  await dialog.getByRole('button', { name: 'Done' }).click()

  // Export can be opened again, and already exported clips start unticked.
  await page.keyboard.press('e')
  await expect(dialog.getByRole('button', { name: 'Export 0 clips' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  const files = readdirSync(output).sort()
  console.log('exported:', files)
  expect(files).toEqual([
    '1994-12-25 Christmas morning (Mum, Dad) @ Butternut, WI.mkv',
    '1995-01-01 New Years party (Mum, Dad) @ Butternut, WI.mkv'
  ])
  const frames = (file: string): number =>
    Number(
      execFileSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0', '-count_packets',
        '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', join(output, file)
      ]).toString()
    )
  // Interlaced source at 25fps: 1s to 8s less a second, and 8s to 16s.
  expect(frames(files[0])).toBe(150)
  expect(frames(files[1])).toBe(200)
  const tags = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', join(output, files[0])]).toString()
  ).format.tags
  expect(tags).toMatchObject({ title: 'Christmas morning', DATE: '1994-12-25', ARTIST: 'Mum, Dad', LOCATION: 'Butternut, WI', LOCATION_ISO6709: '+46.0131-090.4966/', TIME_ZONE: 'America/Chicago' })

  // Everything survives a restart.
  await page.waitForTimeout(600)
  await app.close()
  ;({ app, page } = await launch(userData))
  await expect(page.getByTestId('clip-row')).toHaveCount(2)
  await expect(page.locator('.exported')).toHaveCount(2)
  await page.getByTestId('clip-row').first().click()
  await expect(page.getByTestId('place-pin')).toContainText('46.0131, -90.4966')
  expect(existsSync(tape)).toBe(true)
  await app.close()

  // An unplugged drive or moved file leaves the marks intact and offers to relink.
  const moved = join(work, 'moved tape.mkv')
  renameSync(tape, moved)
  ;({ app, page } = await launch(userData))
  await expect(page.getByText("Can't find this rip")).toBeVisible()
  await expect(page.getByTestId('clip-row')).toHaveCount(2)
  await page.screenshot({ path: join(SCREENSHOTS, '09-missing-source.png') })
  await stubDialogs(app, [moved])
  await page.getByRole('button', { name: 'Locate File…' }).click()
  await expect(page.locator('video')).toBeVisible()
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)

  // Removing a project keeps the rip and the exports.
  await page.getByRole('button', { name: 'Remove Tape 07 Holidays', exact: true }).click({ force: true })
  await expect(page.getByText('Drop your tape rips here')).toBeVisible()
  expect(existsSync(moved)).toBe(true)
  expect(readdirSync(output)).toHaveLength(2)
  await app.close()
})

test('adds files dropped on the window', async () => {
  const work = mkdtempSync(join(tmpdir(), 'mme-e2e-'))
  const tape = join(work, 'dropped.mp4')
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=3,format=yuv420p', '-c:v', 'libx264', tape
  ])
  const { app, page } = await launch(join(work, 'user-data'))
  // Real File objects are needed to resolve paths, so an input provides one.
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'drop-source'
    document.body.append(input)
  })
  await page.locator('#drop-source').setInputFiles(tape)
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#drop-source')!
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(input.files![0])
    input.remove()
    document.querySelector('.app')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  })
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('dropped')
  await app.close()
})

test('plays an H.264 MP4 directly and offers smart cut', async () => {
  const work = mkdtempSync(join(tmpdir(), 'mme-e2e-'))
  const tape = join(work, 'direct.mp4')
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x480:r=25:d=20,format=yuv420p',
    '-f', 'lavfi', '-i', 'sine=d=20', '-c:v', 'libx264', '-preset', 'fast', '-g', '100', '-bf', '2', '-c:a', 'aac', tape
  ])
  const { app, page } = await launch(join(work, 'user-data'))
  await page.evaluate((path) => window.api.addPaths([path]), tape)
  await expect(page.locator('video')).toBeVisible({ timeout: 60_000 })
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
  const [project] = await page.evaluate(async () => {
    const [summary] = await window.api.listProjects()
    return [await window.api.getProject(summary.id)]
  })
  expect(project.analysis.needsProxy).toBe(false)
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('i')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('o')
  await expect(page.getByTestId('clip-row')).toHaveCount(1)
  await page.keyboard.press('e')
  const dialog = page.getByRole('dialog', { name: 'Export clips' })
  await expect(dialog.getByText('Smart cut')).toBeVisible()
  await expect(dialog.getByText(/frames re-encoded \(/)).toBeVisible()
  await app.close()
})

test('quitting mid-preview stops ffmpeg, and a restart resumes with a clean preview', async () => {
  const work = mkdtempSync(join(tmpdir(), 'mme-e2e-'))
  const tape = join(work, 'mme-quit-tape.mkv')
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=720x576:r=25:d=600,tinterlace=interleave_top',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-flags', '+ildct+ilme', '-pix_fmt', 'yuv420p', tape
  ])
  const running = (): number =>
    execSync('ps -axo command').toString().split('\n').filter((line) => line.includes('ffmpeg') && line.includes('mme-quit-tape')).length

  const userData = join(work, 'user-data')
  let { app, page } = await launch(userData)
  await page.evaluate((path) => window.api.addPaths([path]), tape)
  await expect.poll(running, { timeout: 30_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(1500)
  await app.close()
  expect(running()).toBe(0)

  ;({ app, page } = await launch(userData))
  await expect(page.locator('video')).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.project-job')).toHaveCount(0, { timeout: 60_000 })
  const [{ id }] = await page.evaluate(() => window.api.listProjects())
  const directory = join(userData, 'library', id)
  const errors = spawnSync('ffmpeg', ['-v', 'error', '-i', join(directory, 'proxy.mp4'), '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8' }).stderr
  expect(errors).toBe('')
  expect(readdirSync(directory).filter((name) => name.includes('.tmp-'))).toEqual([])
  await app.close()
})
