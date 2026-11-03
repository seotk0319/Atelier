import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ScanSearch, X } from 'lucide-react'
import { isV5Model, tokenLimitForModel } from '@shared/nai-models'
import {
  isCheckable,
  KNOWLEDGE_LABEL,
  knowledgeLevel,
  normalizeTag,
  promptTags,
  type KnowledgeLevel,
  type PromptTag
} from '@shared/tag-knowledge'
import { removeComments } from '@shared/nai-presets'
import { cn } from '../lib/utils'
import { caretCoords } from '../lib/caret'
import { cachedKnowledge, fetchKnowledge, knowledgeTitle } from '../lib/tag-knowledge'
import { KnowledgeDot } from './knowledge-dot'
import { highlightRanges } from '../lib/prompt-weights'
import { sectionOf } from '@shared/char-sections'
import { IMAGE_PATHS_MIME, droppedImagePaths, hasImageDrop } from '../lib/image-drag'
import { fileToBase64 } from '../lib/metadata-request'
import { fragmentPaths } from '../stores/fragments-store'
import { useGenerationStore } from '../stores/generation-store'
import { useTagHelperStore } from '../stores/tag-helper-store'
import { toast } from '../stores/toast-store'

/**
 * 프롬프트 에디터.
 *
 * 하이라이트 구조 (NAIS2의 커서/드래그 어긋남 문제를 피하는 설계):
 * - 글자는 textarea가 "단독으로" 그린다 — 선택·커서·IME 전부 네이티브 동작
 * - 미러(div)는 동일 타이포로 투명 글자를 깔고 배경색만 칠한다
 * - 테두리는 컨테이너가 가진다 (textarea/미러 metrics 완전 동일 보장)
 *
 * 색: 강조({}·양수 가중치)=붉은색, 약화([]·1 미만·음수)=파란색, <조각>=녹색
 * 자동완성: 커서 바로 아래 팝업. `<`는 조각, 그 외 토큰은 단부루 태그(IPC 검색)
 */

// 폰트 크기는 설정값(--prompt-size)을 따름. mirror/textarea가 동일해야 배경 정렬이 맞는다.
// scrollbar-gutter:stable — 스크롤바 자리를 미리 배정(mirror도 동일해야 정렬 유지)
const TYPO =
  'whitespace-pre-wrap break-words p-2.5 font-mono text-[length:var(--prompt-size,15px)] leading-relaxed [scrollbar-gutter:stable]'

type Suggestion =
  | { kind: 'frag'; path: string }
  | { kind: 'tag'; tag: string; count: number; type: string; nai?: boolean }

const TAG_TOKEN_SEPARATORS = /[,\n{}[\]|<>:/]/

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}

const TYPE_COLORS: Record<string, string> = {
  artist: 'text-[#e05c50]',
  character: 'text-[#5c9e6e]',
  copyright: 'text-[#b07fd8]',
  meta: 'text-[#c9a34f]'
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

/** # == charN == 구간 글씨 색 (캐릭터 번호마다, 6명 넘으면 돌려 쓴다). 굵기는 바꾸지 않는다(정렬 유지). */
const CHAR_COLORS = [
  'text-sky-600 dark:text-sky-400',
  'text-emerald-600 dark:text-emerald-400',
  'text-amber-600 dark:text-amber-400',
  'text-rose-600 dark:text-rose-400',
  'text-violet-600 dark:text-violet-400',
  'text-teal-600 dark:text-teal-400'
]
const charColor = (n: number): string => CHAR_COLORS[(n - 1) % CHAR_COLORS.length]

function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

/** 파일 드래그 중에는 아직 그림인지 몰라 item.type으로 확인한다. */
function isImageDrag(e: React.DragEvent): boolean {
  if (e.dataTransfer.types.includes(IMAGE_PATHS_MIME)) return true
  return Array.from(e.dataTransfer.items).some(
    (item) => item.kind === 'file' && (item.type === '' || IMAGE_TYPES.includes(item.type))
  )
}

export function PromptEditor({
  value,
  onValueChange,
  placeholder,
  className,
  negative = false,
  tokensOverride
}: {
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  className?: string
  negative?: boolean
  /** 외부에서 합산한 토큰 수 (기본+캐릭터 합산 등). undefined면 자체 카운트, null이면 숨김 */
  tokensOverride?: number | null
}): React.JSX.Element {
  const model = useGenerationStore((s) => s.request.model)
  const tokenLimit = tokenLimitForModel(model)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const commentRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  // 검색 세대 — 이미 날아간(in-flight) 태그 검색의 스테일 결과가 뒤늦게 패널을 다시 여는 것 방지.
  // (패널이 남으면 Enter가 줄바꿈 대신 자동완성 삽입으로 먹혀 "줄바꿈이 안 된다"로 나타남)
  const searchSeqRef = useRef(0)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [selected, setSelected] = useState(0)
  const [tokenStart, setTokenStart] = useState(-1)
  const [popupPos, setPopupPos] = useState<{ left: number; top: number } | null>(null)
  const [imageHover, setImageHover] = useState(false)
  // 태그 지식 지표: 자동완성 목록용 값, 점검 결과 패널
  const [suggestKnowledge, setSuggestKnowledge] = useState<Record<string, number | null>>({})
  const [check, setCheck] = useState<
    | null
    | { loading: true }
    | {
        loading: false
        rows: (PromptTag & { count: number | null })[]
        skipped: number
        error?: string
        pos: { left: number; top: number }
      }
  >(null)
  const modelLabel = isV5Model(model) ? 'V5' : 'V4.5'

  const ranges = useMemo(() => highlightRanges(value), [value])

  // #주석 회색 글씨 표시용 세그먼트. 줄 맨 앞(선행 공백 허용)의 #만 주석으로 본다.
  // textarea "앞"(위) 레이어로 얹어, 주석 글자만 회색으로 덮어 그린다(전송/토큰은 별도 제외).
  const commentSegments = useMemo(() => {
    // "# == charN ==" 아래 줄(캐릭터 프롬프트로 가는 글)은 캐릭터 번호 색으로 덮어 그린다.
    const segs: { text: string; className: string | null }[] = []
    const lines = value.split('\n')
    let section = 0
    lines.forEach((line, idx) => {
      const nl = idx < lines.length - 1 ? '\n' : ''
      const marker = sectionOf(line)
      if (marker !== null) section = marker
      const className =
        marker !== null
          ? marker > 0
            ? charColor(marker)
            : 'text-faint'
          : line.trimStart().startsWith('#')
            ? 'text-faint'
            : section > 0
              ? charColor(section)
              : null
      segs.push({ text: line + nl, className })
    })
    return segs
  }, [value])

  // 선택 모델 기준 토큰 카운트: V4.5=T5/512, V5=Qwen/1471(Full).
  const [ownTokens, setOwnTokens] = useState<number | null>(null)
  const external = tokensOverride !== undefined
  useEffect(() => {
    if (external) return
    const active = removeComments(value)
    if (!active.trim()) {
      setOwnTokens(null)
      return
    }
    const timer = setTimeout(() => {
      void window.nais
        .invoke('tokens:count', { texts: [active], model })
        .then(({ counts }) => setOwnTokens(counts[0]))
    }, 250)
    return () => clearTimeout(timer)
  }, [value, external, model])
  const tokens = external ? tokensOverride : ownTokens

  // 세로 스크롤바가 생기면 textarea 콘텐츠 폭이 줄어 줄바꿈이 달라진다 —
  // 미러의 오른쪽을 스크롤바 폭만큼 좁혀 두 레이어의 줄바꿈을 항상 일치시킨다
  // 스크롤바 폭 보정은 하지 않는다 — mirror·textarea 둘 다 scrollbar-gutter:stable(TYPO)이라
  // 콘텐츠 폭이 항상 동일. 수동 right 보정을 더하면 이중 인셋으로 줄바꿈이 어긋난다(배경 오정렬).
  const syncScroll = (): void => {
    const ta = textareaRef.current
    const mirror = mirrorRef.current
    if (ta && mirror) {
      mirror.scrollTop = ta.scrollTop
      mirror.scrollLeft = ta.scrollLeft
    }
    const comment = commentRef.current
    if (ta && comment) {
      comment.scrollTop = ta.scrollTop
      comment.scrollLeft = ta.scrollLeft
    }
  }
  useEffect(syncScroll, [value])
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const observer = new ResizeObserver(syncScroll)
    observer.observe(ta)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 커서 아래 팝업 좌표 (뷰포트 기준, 화면 밖으로 나가지 않게 클램프) */
  function placePopup(itemCount: number): void {
    const ta = textareaRef.current
    if (!ta) return
    const caret = caretCoords(ta, ta.selectionStart)
    const rect = ta.getBoundingClientRect()
    const estimatedHeight = Math.min(itemCount, 8) * 27 + 10
    let left = rect.left + caret.left - ta.scrollLeft
    let top = rect.top + caret.top - ta.scrollTop + caret.height + 4
    left = Math.max(8, Math.min(left, window.innerWidth - 288))
    if (top + estimatedHeight > window.innerHeight - 8) {
      top = rect.top + caret.top - ta.scrollTop - estimatedHeight - 4
    }
    setPopupPos({ left, top })
  }

  function refreshSuggestions(text: string, cursor: number): void {
    clearTimeout(debounceRef.current)
    const seq = ++searchSeqRef.current // 이 시점 이전에 발사된 검색 결과는 전부 무효
    const before = text.slice(0, cursor)

    // 줄 맨 앞의 # 주석에서는 추천하지 않는다. 줄 중간의 #은 NAI 문법으로 취급한다.
    const lineStart = before.lastIndexOf('\n') + 1
    if (before.slice(lineStart).trimStart().startsWith('#')) {
      setSuggestions([])
      return
    }

    const frag = /<([^<>|]*)$/.exec(before)
    if (frag) {
      const paths = fragmentPaths(frag[1])
      setTokenStart(cursor - frag[1].length)
      setSuggestions(paths.map((path) => ({ kind: 'frag', path })))
      setSelected(0)
      if (paths.length > 0) placePopup(paths.length)
      return
    }

    let sepIdx = -1
    for (let i = before.length - 1; i >= 0; i--) {
      if (TAG_TOKEN_SEPARATORS.test(before[i])) {
        sepIdx = i
        break
      }
    }
    const rawToken = before.slice(sepIdx + 1)
    const token = rawToken.trimStart()
    const start = sepIdx + 1 + (rawToken.length - token.length)
    if (token.trim().length < 2) {
      setSuggestions([])
      return
    }
    setTokenStart(start)
    debounceRef.current = setTimeout(() => {
      void window.nais
        .invoke('tags:search', { query: token.trim(), limit: 8 })
        .then(({ items }) => {
          if (searchSeqRef.current !== seq) return // 스테일 — 그 사이 입력이 바뀜
          setSuggestions(items.map((t) => ({ kind: 'tag' as const, ...t })))
          setSelected(0)
          if (items.length > 0) placePopup(items.length)
          // 모델이 이 태그를 얼마나 아는지 (NAI 웹의 흰~검 점). 작가 태그는 확인할 수 없어 뺀다
          const ask = items
            .filter((t) => t.type !== 'artist')
            .map((t) => t.tag)
            .filter((t) => isCheckable(normalizeTag(t)))
          const known: Record<string, number | null> = {}
          for (const t of ask) {
            const c = cachedKnowledge(model, t)
            if (c !== undefined) known[normalizeTag(t)] = c
          }
          setSuggestKnowledge(known)
          if (ask.some((t) => cachedKnowledge(model, t) === undefined))
            void fetchKnowledge(model, ask).then(({ counts }) => {
              if (searchSeqRef.current !== seq) return
              setSuggestKnowledge(Object.fromEntries(counts))
            })
        })
    }, 90)
  }

  /** 프롬프트의 태그를 모두 조회해 모델이 잘 모르는 태그를 보여 준다 */
  async function runCheck(anchor: HTMLElement): Promise<void> {
    const tags = promptTags(value)
    const rect = anchor.getBoundingClientRect()
    const pos = {
      left: Math.max(8, Math.min(rect.right - 320, window.innerWidth - 328)),
      top: Math.max(8, rect.top - 8)
    }
    if (!tags.length) {
      setCheck({ loading: false, rows: [], skipped: 0, pos })
      return
    }
    setCheck({ loading: true })
    const { counts, artists, error } = await fetchKnowledge(
      model,
      tags.map((t) => t.key)
    )
    const rows = tags
      .filter((t) => counts.has(t.key))
      .map((t) => ({ ...t, count: counts.get(t.key) ?? null }))
    const skipped = (value.match(/artist:/gi) || []).length + artists.size
    setCheck({ loading: false, rows, skipped, error, pos })
  }

  function selectTag(t: PromptTag): void {
    const ta = textareaRef.current
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(t.start, t.end)
    // 선택한 곳이 보이게 스크롤
    const caret = caretCoords(ta, t.start)
    ta.scrollTop = Math.max(0, caret.top - ta.clientHeight / 3)
    syncScroll()
  }

  function complete(s: Suggestion): void {
    const ta = textareaRef.current
    if (!ta || tokenStart < 0) return
    const cursor = ta.selectionStart
    let insert = s.kind === 'frag' ? s.path + '>' : s.tag
    // 완성 후 바로 다음 태그를 이어 칠 수 있게 ", " 부착 (뒤에 이미 쉼표가 있으면 생략)
    if (!value.slice(cursor).trimStart().startsWith(',')) insert += ', '
    const next = value.slice(0, tokenStart) + insert + value.slice(cursor)
    onValueChange(next)
    setSuggestions([])
    requestAnimationFrame(() => {
      const pos = tokenStart + insert.length
      ta.setSelectionRange(pos, pos)
      ta.focus()
    })
  }

  // 그림(파일 또는 앱 안 드래그)을 놓으면 AI 태그 도우미가 이 칸에 결과를 넣는다.
  async function handleImageDrop(e: React.DragEvent): Promise<void> {
    if (!hasImageDrop(e)) return
    if (!isImageDrag(e)) return
    const file = Array.from(e.dataTransfer.files).find((f) => IMAGE_TYPES.includes(f.type))
    const paths = droppedImagePaths(e)
    e.preventDefault()
    e.stopPropagation()
    setImageHover(false)
    if (!file && paths.length === 0) {
      toast('PNG, JPEG, WEBP 그림만 넣을 수 있어요.', 'info')
      return
    }
    let image: { base64: string; mime: string }
    if (file) image = { base64: await fileToBase64(file), mime: file.type }
    else {
      const res = await window.nais.invoke('images:readForSource', { filePath: paths[0] })
      if ('error' in res) {
        toast(res.error, 'error')
        return
      }
      image = { base64: res.base64, mime: mimeForPath(paths[0]) }
    }
    useTagHelperStore.getState().open({
      image,
      parts: ['look', 'outfit'],
      targetLabel: '프롬프트',
      onApply: (tags, how) =>
        onValueChange(
          how === 'replace' ? tags : value ? value.replace(/[,\s]*$/, '') + ', ' + tags : tags
        )
    })
  }

  return (
    <div
      onDragOver={(e) => {
        if (!hasImageDrop(e) || !isImageDrag(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setImageHover(true)
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null
        if (next && e.currentTarget.contains(next)) return
        setImageHover(false)
      }}
      onDrop={(e) => void handleImageDrop(e)}
      className={cn(
        'relative overflow-hidden rounded-xl border border-transparent bg-paper transition-colors focus-within:border-accent/40',
        negative && 'focus-within:border-danger/40',
        className
      )}
    >
      <div
        ref={mirrorRef}
        aria-hidden
        className={cn(
          TYPO,
          'pointer-events-none absolute inset-0 overflow-hidden text-transparent'
        )}
      >
        {ranges.map((r) =>
          r.bg ? (
            <span key={r.start} style={{ background: r.bg, borderRadius: 3 }}>
              {value.slice(r.start, r.end)}
            </span>
          ) : (
            <span key={r.start}>{value.slice(r.start, r.end)}</span>
          )
        )}
        {value.endsWith('\n') && '​'}
      </div>

      <textarea
        ref={textareaRef}
        className={cn(
          TYPO,
          'relative block h-full w-full resize-none bg-transparent text-ink outline-none placeholder:text-faint'
        )}
        style={{ caretColor: 'var(--ink)' }}
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onValueChange(e.target.value)
          refreshSuggestions(e.target.value, e.target.selectionStart)
        }}
        onScroll={syncScroll}
        onKeyDown={(e) => {
          if (suggestions.length === 0) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSelected((selected + 1) % suggestions.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSelected((selected - 1 + suggestions.length) % suggestions.length)
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            complete(suggestions[selected])
          } else if (e.key === 'Escape') {
            setSuggestions([])
          }
        }}
        onBlur={() => {
          // 포커스가 떠나면 추천 닫기. seq를 올려 in-flight 검색 결과가 뒤늦게 패널을
          // 되열지 못하게 한다 (B7). 150ms 지연은 추천 클릭이 blur보다 먼저 처리되도록.
          clearTimeout(debounceRef.current)
          searchSeqRef.current++
          setTimeout(() => setSuggestions([]), 150)
        }}
      />

      {/* #주석 줄 회색 글씨 오버레이 — textarea 위에 얹어 주석 글자만 회색으로 덮어 그린다 */}
      <div
        ref={commentRef}
        aria-hidden
        className={cn(
          TYPO,
          'pointer-events-none absolute inset-0 overflow-hidden text-transparent'
        )}
      >
        {commentSegments.map((s, i) =>
          s.className ? (
            <span key={i} className={s.className}>
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          )
        )}
        {value.endsWith('\n') && '\u200b'}
      </div>

      <div className="pointer-events-none absolute bottom-1 right-1.5 flex items-center gap-1">
        {!negative && value.trim() && (
          <button
            className="pointer-events-auto grid size-5 place-items-center rounded bg-paper/85 text-faint backdrop-blur-sm transition-colors hover:bg-surface-2 hover:text-ink"
            title={'태그 점검 — ' + modelLabel + '가 이 프롬프트의 태그를 얼마나 아는지 봐요'}
            aria-label="태그 점검"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => void runCheck(e.currentTarget)}
          >
            <ScanSearch size={12} />
          </button>
        )}
        {tokens !== null && (
          <span
            className={cn(
              'rounded bg-paper/85 px-1 font-mono text-[11px] backdrop-blur-sm',
              tokens > tokenLimit ? 'text-danger' : 'text-faint'
            )}
            title={
              tokens > tokenLimit
                ? `한도 초과 — ${tokens}/${tokenLimit} 토큰. 넘친 부분은 잘려서 반영되지 않아요`
                : `${tokens}/${tokenLimit} 토큰`
            }
          >
            {tokens}/{tokenLimit}
          </span>
        )}
      </div>

      {check &&
        createPortal(
          <CheckPanel
            state={check}
            modelLabel={modelLabel}
            onClose={() => setCheck(null)}
            onPick={selectTag}
          />,
          document.body
        )}

      {suggestions.length > 0 &&
        popupPos &&
        createPortal(
          <div
            className="fixed z-50 min-w-52 max-w-72 overflow-hidden rounded-md border border-line bg-surface shadow-xl"
            style={{ left: popupPos.left, top: popupPos.top }}
          >
            {suggestions.map((s, i) => (
              <button
                key={s.kind === 'frag' ? `f:${s.path}` : `t:${s.tag}`}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1 text-left font-mono text-[12px] text-muted',
                  i === selected && 'bg-surface-2 text-ink'
                )}
                onMouseDown={(e) => {
                  e.preventDefault()
                  complete(s)
                }}
              >
                {s.kind === 'frag' ? (
                  <span className="truncate text-[#5cbe7d]">{`<${s.path}>`}</span>
                ) : (
                  <>
                    <span className={cn('min-w-0 flex-1 truncate', TYPE_COLORS[s.type])}>
                      {s.tag}
                    </span>
                    {Object.hasOwn(suggestKnowledge, normalizeTag(s.tag)) && (
                      <KnowledgeDot
                        count={suggestKnowledge[normalizeTag(s.tag)]}
                        title={knowledgeTitle(suggestKnowledge[normalizeTag(s.tag)], modelLabel)}
                      />
                    )}
                    <span className="shrink-0 text-[11px] text-faint">
                      {s.nai ? 'V5' : formatCount(s.count)}
                    </span>
                  </>
                )}
              </button>
            ))}
          </div>,
          document.body
        )}

      {imageHover && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl border border-dashed border-accent bg-surface/90 px-3 text-center text-[12px] font-medium text-accent">
          놓으면 AI 태그 도우미로 태그를 뽑아요
        </div>
      )}
    </div>
  )
}

const LEVEL_ORDER: KnowledgeLevel[] = ['unknown', 'weak', 'fair', 'strong']

/** 태그 점검 결과: 모델이 잘 모르는 태그부터. 누르면 프롬프트에서 그 태그를 선택한다 */
function CheckPanel({
  state,
  modelLabel,
  onClose,
  onPick
}: {
  state:
    | { loading: true }
    | {
        loading: false
        rows: (PromptTag & { count: number | null })[]
        skipped: number
        error?: string
        pos: { left: number; top: number }
      }
  modelLabel: string
  onClose: () => void
  onPick: (t: PromptTag) => void
}): React.JSX.Element | null {
  const [showAll, setShowAll] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (state.loading) return null
  const counts = Object.fromEntries(LEVEL_ORDER.map((l) => [l, 0])) as Record<
    KnowledgeLevel,
    number
  >
  for (const r of state.rows) counts[knowledgeLevel(r.count)]++
  const sorted = [...state.rows].sort((a, b) => (a.count ?? -1) - (b.count ?? -1))
  const shown = showAll ? sorted : sorted.filter((r) => knowledgeLevel(r.count) !== 'strong')
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div
        className="fixed z-50 flex w-80 -translate-y-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
        style={{ left: state.pos.left, top: state.pos.top }}
      >
        <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
          <span className="text-[13px] font-semibold text-ink">태그 점검</span>
          <span className="text-[11px] text-faint">{modelLabel} 기준</span>
          <span className="flex-1" />
          <button
            className="grid size-6 place-items-center rounded-md text-faint hover:bg-surface-2 hover:text-ink"
            aria-label="닫기"
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 pb-2 text-[11px] text-muted">
          {[...LEVEL_ORDER].reverse().map((l) => (
            <span key={l} className="inline-flex items-center gap-1">
              <KnowledgeDot
                count={l === 'strong' ? 10000 : l === 'fair' ? 5000 : l === 'weak' ? 1 : null}
              />
              {KNOWLEDGE_LABEL[l]} {counts[l]}
            </span>
          ))}
        </div>
        <div className="no-scrollbar max-h-72 overflow-y-auto border-t border-line py-1">
          {state.rows.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12px] text-faint">
              {state.error || '확인할 태그가 없어요'}
            </p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12px] text-faint">
              모든 태그를 모델이 잘 알아요
            </p>
          ) : (
            shown.map((r) => (
              <button
                key={r.key}
                className="flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-[12px] text-ink hover:bg-surface-2"
                title={knowledgeTitle(r.count, modelLabel) + '\n누르면 프롬프트에서 선택해요'}
                onClick={() => onPick(r)}
              >
                <KnowledgeDot count={r.count} />
                <span className="min-w-0 flex-1 truncate">{r.tag}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-faint">
                  {r.count == null ? '모름' : r.count.toLocaleString()}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-[11px] text-faint">
          <span className="min-w-0 flex-1 truncate">
            {state.error && state.rows.length
              ? state.error
              : state.skipped
                ? '작가 태그 ' + state.skipped + '개는 확인할 수 없어 뺐어요'
                : '모를수록 다른 이름이나 외형 태그로 풀어 쓰세요'}
          </span>
          {counts.strong > 0 && (
            <button
              className="shrink-0 font-medium text-accent"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? '약한 것만' : '전체 보기'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
