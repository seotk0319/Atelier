// MCP 창구를 앱에 붙이는 곳. Custom 1(알림·로그인 연결이 있는 프로필)에서만 켠다.
// 설정 mcp_enabled 가 '0'이면 열지 않고, mcp_port 로 포트를 바꿀 수 있다.
import { app } from 'electron'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getSetting } from '../db/settings'
import { getInboxWorks, workAccount, workRead, workSend, workWrite } from '../notifications/service'
import { createWorkTools } from '../works/tools'
import type { WorkReadInit, WorkRequest } from '../works/types'
import type { McpActivity, McpStatus } from '../../shared/types'
import type { EditionRecord } from '../../shared/work-freshness'
import { createActivityLog, withActivity, type ActivityLog } from './activity'
import { createEditionStore, type EditionStore } from './editions'
import { probeRemoteMcp } from './remote-probe'
import { createMcpServer, loadConnection, MCP_DEFAULT_PORT } from './server'
import { createViewHost } from '../remote/view-host'

let running: ReturnType<typeof createMcpServer> | null = null
/** 마지막으로 열려고 한 포트와, 열지 못했을 때의 이유 (화면 표시용) */
let lastPort = 0
let lastError: string | null = null

let activity: ActivityLog | null = null
let activityListener: ((item: McpActivity) => void) | null = null

/** 도구 호출 기록을 받을 곳 (ipc가 렌더러로 보낸다) */
export function onMcpActivity(listener: (item: McpActivity) => void): void {
  activityListener = listener
}

let editions: EditionStore | null = null

/** MCP 저장 도구가 성공할 때 남기는 작품별 마지막 저장 기록 */
function editionStore(): EditionStore {
  editions ??= createEditionStore({ file: join(app.getPath('userData'), 'mcp', 'editions.json') })
  return editions
}

function activityLog(): ActivityLog {
  activity ??= createActivityLog({
    file: join(app.getPath('userData'), 'mcp', 'activity.jsonl'),
    onAdd: (item) => {
      editionStore().apply(item)
      activityListener?.(item)
    }
  })
  return activity
}

/** 작품별 MCP 저장 기록 (작품 탭 낡음 판정·works_status). 못 읽으면 빈 목록 */
export async function mcpEditions(): Promise<EditionRecord[]> {
  try {
    return await editionStore().list()
  } catch {
    return []
  }
}

export async function mcpStatus(): Promise<McpStatus> {
  // 이 PC의 MCP를 설정으로 껐으면 같은 포트의 통로 너머(맥미니의 작품 MCP)가 답하는지 본다
  if (!running && getSetting('mcp_enabled') === '0') {
    const saved = Number(getSetting('mcp_port'))
    const port =
      Number.isInteger(saved) && saved >= 1024 && saved <= 65535 ? saved : MCP_DEFAULT_PORT
    return { running: false, port, url: '', error: null, remote: await probeRemoteMcp(port) }
  }
  return {
    running: !!running,
    port: lastPort,
    url: running ? 'http://127.0.0.1:' + lastPort + '/mcp' : '',
    error: lastError
  }
}

export async function mcpActivity(limit?: number): Promise<{ items: McpActivity[] }> {
  try {
    return { items: await activityLog().list(limit) }
  } catch {
    return { items: [] }
  }
}

// 저장 직전 백업과 저장 뒤 확인본이 같은 초에 생겨도 서로 덮어쓰지 않게 밀리초까지 넣는다
const stamp = (): string => new Date().toISOString().replace(/[-:.]/g, '').replace(/Z$/, '')

function withAccount<F extends (...args: never[]) => Promise<Response>>(
  platform: string,
  fn: F
): F {
  const account = (): Promise<unknown> => workAccount(platform)
  return Object.assign(fn, { rplayAccount: account, teapotAccount: account })
}

export async function startMcp(): Promise<void> {
  if (running || getSetting('mcp_enabled') === '0') return
  const saved = Number(getSetting('mcp_port'))
  const port = Number.isInteger(saved) && saved >= 1024 && saved <= 65535 ? saved : MCP_DEFAULT_PORT
  const root = join(app.getPath('userData'), 'mcp')
  lastPort = port
  lastError = null
  try {
    const { token } = await loadConnection(join(root, 'connection.json'), port)
    const host = createViewHost({ mcpStatus, mcpActivity, mcpEditions })
    const server = createMcpServer({
      port,
      token,
      view: host.view,
      thumb: host.thumb,
      info: { name: 'atelier-works', version: app.getVersion() },
      tools: withActivity(
        createWorkTools({
          // 통로 함수에 계정 번호 꺼내는 함수를 붙여 둔다 (알플레이·티팟은 주소에 내 계정 번호가 들어간다)
          reader: (platform) =>
            withAccount(platform, (url: string, init?: WorkReadInit) =>
              workRead(platform, url, init)
            ),
          writer: (platform) =>
            withAccount(platform, (method: string, url: string, body?: unknown) =>
              workWrite(platform, method, url, body)
            ),
          sender: (platform) =>
            withAccount(platform, (request: WorkRequest) => workSend(platform, request)),
          readFile: (path) => readFile(path, 'utf8'),
          // 이미지 파일은 크기를 먼저 보고, 한도 안일 때만 읽는다
          async readBinary(path, maxBytes) {
            const info = await stat(path)
            if (!info.isFile() || info.size > maxBytes) throw new Error('BAD_FILE')
            return readFile(path)
          },
          async listFolder(path) {
            const entries = await readdir(path, { withFileTypes: true })
            return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
          },
          // 저장된 목록만 읽는다 (cached: 오래됐어도 사이트에 묻지 않는다)
          async worksStatus() {
            const [works, saved] = await Promise.all([
              getInboxWorks(false, true).catch(() => null),
              mcpEditions()
            ])
            return { works, saved }
          },
          async snapshot(platform, name, raw) {
            const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_')
            const dir = join(root, 'snapshots', platform, safe)
            await mkdir(dir, { recursive: true })
            const file = join(dir, stamp() + '.json')
            await writeFile(file, JSON.stringify(raw, null, 2))
            return file
          }
        }),
        activityLog()
      )
    })
    await server.start()
    running = server
  } catch (error) {
    // 포트가 이미 쓰이는 등으로 못 열어도 앱의 다른 기능은 그대로 돈다.
    const message = error instanceof Error ? error.message : String(error)
    lastError = message.slice(0, 200)
    console.error('[mcp] 창구를 열지 못했어요:', message)
  }
}

export async function stopMcp(): Promise<void> {
  const server = running
  running = null
  if (server) await server.stop()
}
