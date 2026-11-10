// MCP 창구를 앱에 붙이는 곳. Custom 1(알림·로그인 연결이 있는 프로필)에서만 켠다.
// 설정 mcp_enabled 가 '0'이면 열지 않고, mcp_port 로 포트를 바꿀 수 있다.
import { app } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getSetting } from '../db/settings'
import { workRead } from '../notifications/service'
import { createWorkTools } from '../works/tools'
import { createMcpServer, loadConnection, MCP_DEFAULT_PORT } from './server'

let running: ReturnType<typeof createMcpServer> | null = null

const stamp = (): string => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')

export async function startMcp(): Promise<void> {
  if (running || getSetting('mcp_enabled') === '0') return
  const saved = Number(getSetting('mcp_port'))
  const port = Number.isInteger(saved) && saved >= 1024 && saved <= 65535 ? saved : MCP_DEFAULT_PORT
  const root = join(app.getPath('userData'), 'mcp')
  try {
    const { token } = await loadConnection(join(root, 'connection.json'), port)
    const server = createMcpServer({
      port,
      token,
      info: { name: 'nais3-works', version: app.getVersion() },
      tools: createWorkTools({
        reader: (platform) => (url) => workRead(platform, url),
        async snapshot(platform, name, raw) {
          const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_')
          const dir = join(root, 'snapshots', platform, safe)
          await mkdir(dir, { recursive: true })
          const file = join(dir, stamp() + '.json')
          await writeFile(file, JSON.stringify(raw, null, 2))
          return file
        }
      })
    })
    await server.start()
    running = server
  } catch (error) {
    // 포트가 이미 쓰이는 등으로 못 열어도 앱의 다른 기능은 그대로 돈다.
    console.error('[mcp] 창구를 열지 못했어요:', error instanceof Error ? error.message : error)
  }
}

export async function stopMcp(): Promise<void> {
  const server = running
  running = null
  if (server) await server.stop()
}
