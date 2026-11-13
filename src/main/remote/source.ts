// 플랫폼 내용을 어디서 가져올지: 이 PC가 직접 모으기('direct') / 맥미니에서 받기('macmini').
// 설정 platform_source 로 고른다. 맥미니와는 작품 MCP와 같은 포트(mcp_port)의 통로로 이어진다.
import { app } from 'electron'
import { join } from 'node:path'
import { getSetting } from '../db/settings'
import { MCP_DEFAULT_PORT } from '../mcp/server'
import { createViewClient, type ViewClient } from './view-client'

export type PlatformSource = 'direct' | 'macmini'

export const platformSource = (): PlatformSource =>
  getSetting('platform_source') === 'macmini' ? 'macmini' : 'direct'

function port(): number {
  const saved = Number(getSetting('mcp_port'))
  return Number.isInteger(saved) && saved >= 1024 && saved <= 65535 ? saved : MCP_DEFAULT_PORT
}

let client: ViewClient | null = null
export function viewClient(): ViewClient {
  client ??= createViewClient({
    port,
    tokenFile: join(app.getPath('userData'), 'mcp', 'connection.json'),
    cacheDir: join(app.getPath('userData'), 'remote-cache')
  })
  return client
}

export const remotePort = port
