// 댓글 분류 본체. 결과는 creator-inbox/topics.json 에 두고 다시 묻지 않는다.
// 엔진은 OpenRouter 키가 있으면 DeepSeek, 없으면 Claude Haiku. 댓글 본문만 보낸다.
import { app } from 'electron'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AI_MODEL } from '../../shared/ai-reply'
import { DEEPSEEK_MODEL } from '../../shared/llm'
import type { InboxTopicInfo } from '../../shared/inbox-topic'
import { getClaudeKey, getOpenRouterKey } from '../db/settings'
import { claudeMessage } from '../ai-reply/claude'
import { openrouterChatFull } from '../llm/openrouter'
import {
  isTopicText,
  parseTopics,
  TOPIC_BATCH,
  TOPIC_SYSTEM,
  topicCandidates,
  topicUserText,
  type StoredTopic,
  type TopicInput
} from './topic-prompt'

interface TopicFile {
  v: 1
  items: Record<string, StoredTopic>
  usage: { requests: number; input: number; output: number }
}

const file = (): string => join(app.getPath('userData'), 'creator-inbox', 'topics.json')
let data: TopicFile | null = null
let loading: Promise<TopicFile> | null = null
let running = false
let pending = 0
let lastError: string | null = null
let retryAt = 0

async function load(): Promise<TopicFile> {
  if (data) return data
  loading ??= (async () => {
    try {
      const raw = JSON.parse(await readFile(file(), 'utf8')) as Partial<TopicFile>
      data = {
        v: 1,
        items: raw.items && typeof raw.items === 'object' ? raw.items : {},
        usage: raw.usage ?? { requests: 0, input: 0, output: 0 }
      }
    } catch {
      data = { v: 1, items: {}, usage: { requests: 0, input: 0, output: 0 } }
    }
    return data
  })()
  return loading
}

async function save(): Promise<void> {
  if (!data) return
  const tmp = file() + '.' + process.pid + '.tmp'
  await writeFile(tmp, JSON.stringify(data))
  await rename(tmp, file()).catch(() => undefined)
}

/** 화면 쪽 조회용: id → 분류 */
export async function topicMap(): Promise<Record<string, StoredTopic>> {
  return (await load()).items
}
export const toTopicInfo = (s: StoredTopic | undefined): InboxTopicInfo | null =>
  s ? { topic: s.t, summary: s.s } : null
export function topicState(): { pending: number; error: string | null } {
  return { pending, error: lastError }
}

async function ask(batch: TopicInput[]): Promise<{ text: string; input: number; output: number }> {
  const user = topicUserText(batch)
  const openrouter = (getOpenRouterKey() || '').trim()
  if (openrouter) {
    const r = await openrouterChatFull(openrouter, {
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: TOPIC_SYSTEM },
        { role: 'user', content: user }
      ],
      maxTokens: 2400,
      temperature: 0,
      timeoutMs: 90_000
    })
    return { text: r.text, input: r.usage.input, output: r.usage.output }
  }
  const claude = (getClaudeKey() || '').trim()
  if (!claude) throw new Error('NO_KEY')
  const r = await claudeMessage(claude, {
    model: AI_MODEL,
    max_tokens: 2400,
    system: TOPIC_SYSTEM,
    messages: [{ role: 'user', content: user }]
  })
  const text = (r.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('')
  return { text, input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0 }
}

export interface TopicSource {
  id: string
  event: string
  at: string | null
  text: string
  work: string | null
}

/**
 * 아직 안 나눈 댓글을 뒤에서 나눈다 (한 번에 최대 8묶음 = 200개). 이미 돌고 있으면 남은 수만 갱신한다.
 * 실패하면 2분 뒤에 다시 해 본다.
 */
export async function classifyTopics(items: TopicSource[]): Promise<void> {
  const store = await load()
  // 본문 없는 알림 문구로 예전에 나눈 것은 지운다 (목록에 "기타"로 남지 않게)
  let dropped = false
  for (const it of items) {
    if (store.items[it.id] && !isTopicText(it.text)) {
      delete store.items[it.id]
      dropped = true
    }
  }
  if (dropped && !running) await save()
  const todo = topicCandidates(items, store.items)
  pending = todo.length
  if (running || !todo.length || Date.now() < retryAt) return
  if (!(getOpenRouterKey() || '').trim() && !(getClaudeKey() || '').trim()) {
    lastError = '분류하려면 설정에서 OpenRouter 또는 Claude 키를 넣어 주세요.'
    return
  }
  running = true
  try {
    for (let i = 0; i < Math.min(todo.length, TOPIC_BATCH * 8); i += TOPIC_BATCH) {
      const batch = todo.slice(i, i + TOPIC_BATCH)
      const r = await ask(batch)
      const found = parseTopics(r.text, batch)
      for (const [id, t] of found) store.items[id] = t
      store.usage.requests++
      store.usage.input += r.input
      store.usage.output += r.output
      pending = Math.max(0, pending - found.size)
      await save()
      if (!found.size) throw new Error('EMPTY')
    }
    lastError = null
  } catch {
    lastError = '댓글 분류가 잠시 멈췄어요. 2분 뒤 다시 해 볼게요.'
    retryAt = Date.now() + 120_000
  } finally {
    running = false
  }
}
