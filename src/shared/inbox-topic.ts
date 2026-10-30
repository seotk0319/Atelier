import type { InboxItem } from './inbox'

/** 댓글 내용 분류. 크리에이터가 할 일이 큰 순서로 적는다 */
export const INBOX_TOPICS = {
  bug: '오류·수정',
  asset: '에셋 요청',
  request: '기능·내용 요청',
  question: '질문',
  praise: '감상',
  other: '기타'
} as const
export type InboxTopic = keyof typeof INBOX_TOPICS
export const INBOX_TOPIC_IDS = Object.keys(INBOX_TOPICS) as InboxTopic[]

export interface InboxTopicInfo {
  topic: InboxTopic
  /** 크리에이터가 할 일 한 문장 (감상·기타는 null) */
  summary: string | null
}

export const isInboxTopic = (v: unknown): v is InboxTopic =>
  typeof v === 'string' && Object.hasOwn(INBOX_TOPICS, v)

/** 할 일이 있는 분류 (배지·요약 복사를 보여준다) */
export const ACTION_TOPICS: readonly InboxTopic[] = ['bug', 'asset', 'request', 'question']

/** 작품 세션에 넘기기 좋은 한 덩어리 */
export function topicCopyText(
  item: Pick<InboxItem, 'platform' | 'title' | 'body' | 'actor' | 'work' | 'at' | 'url'>,
  info: InboxTopicInfo,
  platformLabel: string,
  date: string
): string {
  const lines = [
    '[' +
      INBOX_TOPICS[info.topic] +
      '] ' +
      (item.work?.title || item.title) +
      ' · ' +
      platformLabel,
    '작성: ' + (item.actor?.name || '이름 없음') + (date ? ' · ' + date : '')
  ]
  if (info.summary) lines.push('요약: ' + info.summary)
  if (item.body) lines.push('원문: ' + item.body)
  if (item.url) lines.push('링크: ' + item.url)
  return lines.join('\n')
}
