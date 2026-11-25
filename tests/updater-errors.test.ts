import { describe, expect, it, vi } from 'vitest'

vi.mock('electron-updater', () => ({ default: { autoUpdater: { on: () => undefined } } }))
vi.mock('electron', () => ({ app: { on: () => undefined, getVersion: () => '0.2.0' }, shell: {} }))
vi.mock('../src/main/ipc', () => ({ broadcast: () => undefined }))
vi.mock('../src/main/profile', () => ({ PROFILE: 1, UPDATE_PROFILE_MARKER: 'm.json' }))

const err = (message: string, code?: string): Error => Object.assign(new Error(message), { code })

describe('update error text', () => {
  it('has no English when there is no release or no latest.yml', async () => {
    const { friendlyError } = await import('../src/main/updater')
    for (const e of [
      err('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'),
      err(
        'Cannot find latest.yml in the latest release artifacts (https://x): HttpError: 404',
        'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
      ),
      err(
        'Unable to find latest version on GitHub (https://x), please ensure a production release exists'
      )
    ]) {
      const text = friendlyError(e)
      expect(text).toContain('업데이트 정보가 없어요')
      expect(text).not.toMatch(/[A-Za-z]{4,}/)
    }
  })

  it('keeps unknown English out of the screen', async () => {
    const { friendlyError } = await import('../src/main/updater')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(friendlyError(err('Something odd happened inside'))).toBe(
      '업데이트를 확인하지 못했어요. 조금 뒤 다시 해 주세요.'
    )
    expect(friendlyError(err('getaddrinfo ENOTFOUND github.com'))).toContain('인터넷')
  })
})
