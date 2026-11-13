// 집 PC 아틀리에가 맥미니(아틀리에MCP)에서 화면에 쓸 내용을 받아 오는 약속.
// 맥미니는 작품 MCP와 같은 포트의 /view 로 아래 채널만 받는다. 이름과 주고받는 모양은
// 화면이 본체에 묻던 IPC 채널(IpcInvokeMap)과 같다.

/** 읽기만 하는 채널. 집 PC는 받은 답을 디스크에 두었다가 끊겼을 때 받은 시각과 함께 보여 준다. */
export const VIEW_READ = [
  'inbox:query',
  'inbox:works',
  'mcp:activity',
  'mcp:status',
  'aiReply:status',
  'aiReply:log',
  'aiReply:entry'
] as const

/** 아빠가 누른 단추를 맥미니에 전하는 채널. 끊겼으면 실패로 알린다(캐시로 답하지 않는다). */
export const VIEW_ACT = [
  'inbox:control',
  'inbox:setInterval',
  'inbox:select',
  'inbox:reply',
  'inbox:replyTarget',
  'inbox:sourceUrl',
  'aiReply:setConfig',
  'aiReply:setEngine',
  'aiReply:draft',
  'aiReply:backlogPreview',
  'aiReply:backlogStart',
  'aiReply:backlogStop'
] as const

export type ViewReadChannel = (typeof VIEW_READ)[number]
export type ViewActChannel = (typeof VIEW_ACT)[number]
export type ViewChannel = ViewReadChannel | ViewActChannel

const READ = new Set<string>(VIEW_READ)
const ACT = new Set<string>(VIEW_ACT)
export const isViewRead = (channel: string): channel is ViewReadChannel => READ.has(channel)
export const isViewChannel = (channel: string): channel is ViewChannel =>
  READ.has(channel) || ACT.has(channel)

/** /view 의 답. at은 맥미니가 답을 만든 시각(ISO) */
export type ViewReply =
  { ok: true; at: string; res: unknown } | { ok: false; at: string; error: string }

/** 맥미니에서 받아 보여 주는 화면이 함께 받는 표시 */
export interface RemoteStamp {
  /** 이 내용을 맥미니에서 받은 시각(ISO) */
  receivedAt: string
  /** 지금은 맥미니와 끊겨서 마지막으로 받은 것을 보여 주는 중 */
  stale: boolean
}
