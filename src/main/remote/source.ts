// 알림·작품·AI 답글 화면의 내용은 맥미니(아틀리에MCP)에서 받는다.
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

/** 맥미니 연결 정보 파일이 있는지. 없으면(새로 깐 PC) 작품·알림 화면을 보여 주지 않는다 */
export function remoteConfigured(): boolean {
  return existsSync(tokenFile())
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
