// DeepSeek 번역 연결부. OpenRouter Chat Completions에 번역만 시키고, 실패는 OpenRouterError로 온다.
import { DEEPSEEK_MODEL } from '../../shared/llm'
import { openrouterChat } from '../llm/openrouter'

export interface DeepSeekTranslateOptions {
  text: string
  target: string
  source?: string | null
}

const TARGET_NAMES: Record<string, string> = {
  KO: 'Korean',
  'EN-US': 'natural American English',
  'ZH-HANT': 'Traditional Chinese as used in Taiwan',
  JA: 'natural Japanese'
}

function systemPrompt(target: string, source?: string | null): string {
  const language = TARGET_NAMES[target] || target
  const hint = source ? `The original language is likely ${source}; confirm it yourself.` : ''
  return [
    'You are a professional translator for character-chat platform comments.',
    `Translate the user's message into ${language}.`,
    'Keep the tone, slang, emoji, line breaks, character names and @mentions.',
    'Convert Korean internet laughter and jamo shorthand (ㅎㅎ, ㅋㅋ, ㅠㅠ) into the natural target-language equivalent (Japanese: 笑 or w, Chinese: 哈哈 or QQ, English: haha or lol, Korean: keep as is).',
    'Match how a native speaker writes on a fan community; keep it natural, not literal.',
    'Output ONLY the translation in the text field. Do not add quotes, notes or explanations.',
    hint,
    'Also detect the language of the original text.',
    'Answer with JSON only, in exactly this shape:',
    '{"detected":"JA","text":"..."}',
    'detected is an ISO 639-1 code in capitals: KO, EN, JA, ZH, ...'
  ]
    .filter(Boolean)
    .join('\n')
}

/** JSON 앞뒤의 코드 펜스를 걷어낸다. */
function unfence(raw: string): string {
  return raw
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

/** EN-US, ZH-HANT 같은 표기를 DeepL이 돌려주는 EN, ZH 형태로 맞춘다. */
function normalizeDetected(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const upper = value.trim().toUpperCase()
  if (!upper) return null
  const base = upper.split(/[-_\s]/)[0]
  return /^[A-Z]{2,3}$/.test(base) ? base : null
}

/**
 * 모델 답을 {text, detected}로 푼다. JSON이 아니면 답 전체를 번역문으로 본다.
 * 코드 펜스나 앞뒤 설명이 붙어도 안쪽 JSON 객체를 한 번 더 찾아본다.
 */
export function parseDeepSeekReply(raw: string): { text: string; detected: string | null } {
  const whole = String(raw ?? '').trim()
  const clean = unfence(whole)
  const candidates = [clean]
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(clean.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object') {
        const row = parsed as { text?: unknown; detected?: unknown }
        if (typeof row.text === 'string' && row.text.trim()) {
          return { text: row.text, detected: normalizeDetected(row.detected) }
        }
      }
    } catch {
      // 다음 후보로 넘어간다.
    }
  }
  return { text: clean || whole, detected: null }
}

export async function deepseekTranslate(
  key: string,
  options: DeepSeekTranslateOptions,
  fetcher: typeof fetch = fetch
): Promise<{ text: string; detected: string | null }> {
  const body = String(options.text || '').trim()
  const reply = await openrouterChat(
    key,
    {
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: systemPrompt(options.target, options.source) },
        { role: 'user', content: body }
      ],
      maxTokens: Math.max(1000, Math.min(8000, Math.ceil(body.length * 1.6) + 400)),
      temperature: 0.2
    },
    fetcher
  )
  return parseDeepSeekReply(reply)
}
