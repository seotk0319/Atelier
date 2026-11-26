// 알림·작품·AI 답글 화면의 내용을 어디서 가져올지.
// 맥미니 연결 정보 파일이 있으면 맥미니(아틀리에MCP)에서 받고('macmini'),
// 없으면 이 PC가 크롬 로그인으로 직접 모은다('direct').
// 맥미니와는 작품 MCP와 같은 포트(mcp_port)의 통로로 이어진다.
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getSetting } from '../db/settings'
import { createViewClient, type ViewClient } from './view-client'

/** 맥미니 작품 MCP의 기본 포트 (설정 mcp_port 가 없을 때) */
const MCP_DEFAULT_PORT = 39317

function port(): number {
  const saved = Number(getSetting('mcp_port'))
  return Number.isInteger(saved) && saved >= 1024 && saved <= 65535 ? saved : MCP_DEFAULT_PORT
}

const tokenFile = (): string => join(app.getPath('userData'), 'mcp', 'connection.json')

/** 맥미니 연결 정보 파일이 있는지. 없으면(새로 깐 PC) 이 PC가 직접 모은다 */
export function remoteConfigured(): boolean {
  return existsSync(tokenFile())
}

export type PlatformSource = 'direct' | 'macmini'

let source: PlatformSource | null = null
/** 켤 때 한 번 정한다 (도는 중에 바뀌면 수집과 화면이 서로 다른 곳을 본다) */
export function platformSource(): PlatformSource {
  source ??= remoteConfigured() ? 'macmini' : 'direct'
  return source
}

let client: ViewClient | null = null
export function viewClient(): ViewClient {
  client ??= createViewClient({
    port,
    tokenFile: tokenFile(),
    cacheDir: join(app.getPath('userData'), 'remote-cache')
  })
  return client
}

export const remotePort = port
