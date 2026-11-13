// 맥미니(아틀리에MCP) 쪽: 집 PC 아틀리에 화면이 받아 갈 내용을 내주는 곳.
// 채널마다 화면이 본체에 묻던 것과 같은 함수를 부른다. 로그인 창 열기·끊기와 키 넣기는
// 여기 없다(맥미니 화면에서만 한다).
import { net } from 'electron'
import {
  controlInbox,
  getInbox,
  getInboxWorks,
  inboxSourceUrl,
  previewReply,
  replyInbox,
  selectInboxPlatform,
  setInboxInterval
} from '../notifications/service'
import { sniffImage, thumbAllowed } from '../notifications/work-images'
import {
  aiEntry,
  aiLog,
  aiStatus,
  draftReply,
  previewBacklog,
  setAiConfig,
  setAiEngine,
  startBacklog,
  stopBacklog
} from '../ai-reply/service'
import type { IpcInvokeMap, McpActivity, McpStatus } from '../../shared/types'
import type { EditionRecord } from '../../shared/work-freshness'
import type { ViewChannel } from '../../shared/remote-view'

type Req<C extends keyof IpcInvokeMap> = IpcInvokeMap[C]['req']

export interface ViewHostDeps {
  mcpStatus(): Promise<McpStatus>
  mcpActivity(limit?: number): Promise<{ items: McpActivity[] }>
  mcpEditions(): Promise<EditionRecord[]>
}

const THUMB_MAX = 12 * 1024 * 1024

export function createViewHost(deps: ViewHostDeps): {
  view(channel: string, req: unknown): Promise<unknown>
  thumb(url: string): Promise<{ type: string; bytes: Uint8Array } | null>
} {
  const handlers: Record<ViewChannel, (req: never) => Promise<unknown> | unknown> = {
    'inbox:query': (req: Req<'inbox:query'>) => getInbox(req || {}),
    'inbox:works': async (req: Req<'inbox:works'>) => {
      const [works, saved] = await Promise.all([
        getInboxWorks(!!req?.refresh, !!req?.cached),
        deps.mcpEditions()
      ])
      return { ...works, saved }
    },
    'mcp:activity': (req: Req<'mcp:activity'>) => deps.mcpActivity(Number(req?.limit) || undefined),
    'mcp:status': () => deps.mcpStatus(),
    'aiReply:status': () => aiStatus(),
    'aiReply:log': (req: Req<'aiReply:log'>) => aiLog(Number(req?.limit) || 30),
    'aiReply:entry': (req: Req<'aiReply:entry'>) => aiEntry(String(req?.id || '')),
    'inbox:control': (req: Req<'inbox:control'>) => controlInbox(req?.enabled),
    'inbox:setInterval': (req: Req<'inbox:setInterval'>) => setInboxInterval(req?.minutes),
    'inbox:select': (req: Req<'inbox:select'>) =>
      selectInboxPlatform(String(req?.platform || ''), req?.selected),
    'inbox:reply': (req: Req<'inbox:reply'>) =>
      replyInbox(String(req?.id || ''), String(req?.content || '')),
    'inbox:replyTarget': (req: Req<'inbox:replyTarget'>) => previewReply(String(req?.id || '')),
    'inbox:sourceUrl': (req: { id?: string }) => inboxSourceUrl(String(req?.id || '')),
    'aiReply:setConfig': (req: Req<'aiReply:setConfig'>) => setAiConfig(req || {}),
    'aiReply:setEngine': (req: Req<'aiReply:setEngine'>) => setAiEngine(req?.engine),
    'aiReply:draft': async (req: Req<'aiReply:draft'>) => {
      const result = await draftReply(String(req?.id || ''))
      delete result.code
      return result
    },
    'aiReply:backlogPreview': (req: Req<'aiReply:backlogPreview'>) =>
      previewBacklog(Number(req?.days) || 0),
    'aiReply:backlogStart': (req: Req<'aiReply:backlogStart'>) => startBacklog(req),
    'aiReply:backlogStop': () => stopBacklog()
  }

  return {
    async view(channel, req) {
      const run = handlers[channel as ViewChannel] as ((req: unknown) => unknown) | undefined
      if (!run) throw new Error('UNKNOWN_CHANNEL')
      return run(req)
    },
    // 화면의 nais-thumb 프로토콜과 같은 규칙: 로그인한 계정의 응답에서 본 이미지 호스트만 받는다
    async thumb(url) {
      if (!thumbAllowed(url)) return null
      const response = await net.fetch(url, { redirect: 'error' })
      if (!response.ok) return null
      const bytes = new Uint8Array(await response.arrayBuffer())
      const type = sniffImage(bytes)
      return type && bytes.length <= THUMB_MAX ? { type, bytes } : null
    }
  }
}
