// 댓글 분류 프롬프트와 답 읽기. 순수 함수라 본체(topics.ts)와 검사가 같이 쓴다.
import { createHash } from 'node:crypto'
import { isInboxTopic, type InboxTopic } from '../../shared/inbox-topic'

export interface TopicInput {
  id: string
  work: string | null
  text: string
}
export interface StoredTopic {
  t: InboxTopic
  s: string | null
  /** 분류한 본문의 지문. 본문이 바뀌면 다시 나눈다 */
  h: string
}

export const TOPIC_BATCH = 25
const TEXT_MAX = 400

/** 본문 없이 알림 문구만 온 것 (크랙 "○○에 달린 댓글을 확인하세요", 루나 "캐릭터 댓글" 등) */
const PLACEHOLDER =
  /^(?:.+에 달린 (?:댓글|답글)을 확인하세요\.?|(?:캐릭터|제작자 페이지) (?:댓글|답글)|댓글 답글|(?:새 )?(?:댓글|답글))$/
export const isTopicText = (text: string): boolean => {
  const t = text.trim()
  return !!t && !PLACEHOLDER.test(t)
}

export const topicHash = (text: string): string =>
  createHash('sha1').update(text).digest('hex').slice(0, 12)

export const TOPIC_SYSTEM = [
  '너는 캐릭터챗 크리에이터의 작품에 달린 댓글을 분류한다. 각 댓글을 아래 중 하나로 나눈다.',
  '- bug: 작품이 의도대로 안 된다는 제보나 고쳐 달라는 요청. 이미지가 안 나옴, 엉뚱한 이미지, 상태창·스탯·명령어·설정이 이상함, 오타, 번역 누락, 시작이 안 됨 등.',
  '- asset: 이미지(에셋)를 더 넣어 달라는 요청. 장면, 의상, 표정, 셀카, 특정 상황 그림 추가 등.',
  '- request: 에셋이 아닌 내용 추가·변경 요청. 캐릭터, 모드, 시작 상황, 시나리오, 설정, 기능을 더하거나 바꿔 달라는 것.',
  '- question: 사용법, 설정, 조건, 추천 모델 등을 묻는 질문.',
  '- praise: 감상, 칭찬, 리액션, 드립, 인사, 플레이 후기.',
  '- other: 스팸, 광고, 뜻을 알 수 없음, 그 밖.',
  '여러 개에 걸치면 크리에이터가 할 일이 큰 쪽을 고른다: bug > asset > request > question > praise.',
  '질문 형태라도 오류를 알리는 것이면 bug, 추가해 달라는 뜻이면 asset이나 request다.',
  '',
  'summary: bug·asset·request·question은 크리에이터가 할 일을 한국어 한 문장(40자 안팎)으로 쓴다. 댓글이 외국어여도 한국어로 쓴다. praise·other는 빈 문자열.',
  '',
  '답은 JSON 배열 하나로만 낸다. 코드 블록이나 설명을 붙이지 않는다.',
  '[{"i":1,"t":"bug","s":"3번 이미지가 다른 캐릭터로 나옴, 확인 필요"},{"i":2,"t":"praise","s":""}]'
].join('\n')

export function topicUserText(batch: TopicInput[]): string {
  return batch
    .map(
      (b, n) =>
        n +
        1 +
        '. ' +
        (b.work ? '[작품: ' + b.work + '] ' : '') +
        b.text.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX)
    )
    .join('\n')
}

/** 모델 답을 읽어 id → 분류로. 번호가 틀리거나 분류가 이상한 줄은 버린다 */
export function parseTopics(raw: string, batch: TopicInput[]): Map<string, StoredTopic> {
  const out = new Map<string, StoredTopic>()
  const clean = String(raw ?? '')
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  const start = clean.indexOf('[')
  const end = clean.lastIndexOf(']')
  if (start < 0 || end <= start) return out
  let rows: unknown
  try {
    rows = JSON.parse(clean.slice(start, end + 1))
  } catch {
    return out
  }
  if (!Array.isArray(rows)) return out
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as { i?: unknown; t?: unknown; s?: unknown }
    const n = Number(r.i)
    const target = Number.isInteger(n) ? batch[n - 1] : undefined
    if (!target || !isInboxTopic(r.t)) continue
    const summary = typeof r.s === 'string' ? r.s.trim().slice(0, 120) : ''
    out.set(target.id, {
      t: r.t,
      s: r.t === 'praise' || r.t === 'other' || !summary ? null : summary,
      h: topicHash(target.text)
    })
  }
  return out
}

/** 분류할 댓글: 본문이 있고, 아직 안 나눴거나 본문이 바뀐 것. 최근 것부터 */
export function topicCandidates<
  T extends { id: string; event: string; at: string | null; text: string; work: string | null }
>(items: T[], stored: Record<string, StoredTopic>): TopicInput[] {
  return items
    .filter((it) => (it.event === 'comment' || it.event === 'reply') && isTopicText(it.text))
    .filter((it) => stored[it.id]?.h !== topicHash(it.text))
    .sort((a, b) => (Date.parse(b.at || '') || 0) - (Date.parse(a.at || '') || 0))
    .map((it) => ({ id: it.id, work: it.work, text: it.text }))
}
