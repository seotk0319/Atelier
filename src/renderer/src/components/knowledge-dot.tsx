import { KNOWLEDGE_LABEL, knowledgeLevel, type KnowledgeLevel } from '@shared/tag-knowledge'
import { cn } from '../lib/utils'

/** 태그 지식 점: 잘 앎(초록) · 애매(노랑) · 약함(주황) · 모름(빨간 테두리) */
const DOT: Record<KnowledgeLevel, string> = {
  strong: 'bg-emerald-500',
  fair: 'bg-amber-400',
  weak: 'bg-orange-500',
  unknown: 'border border-danger bg-transparent'
}

export function KnowledgeDot({
  count,
  className,
  title
}: {
  count: number | null
  className?: string
  title?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        DOT[knowledgeLevel(count)],
        className
      )}
      title={title}
      aria-label={KNOWLEDGE_LABEL[knowledgeLevel(count)]}
    />
  )
}
