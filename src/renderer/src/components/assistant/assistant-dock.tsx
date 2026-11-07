import {
  ArrowRight,
  ArrowUp,
  BookText,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  Eye,
  FolderPlus,
  Info,
  Loader2,
  PenLine,
  Plus,
  Sparkles,
  Undo2,
  X
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ASSISTANT_MODELS } from '@shared/assistant'
import { cn } from '../../lib/utils'
import {
  useAssistantStore,
  viewLabel,
  type AssistantItem,
  type PlanRow
} from '../../stores/assistant-store'
import { useLayoutStore } from '../../stores/layout-store'
import { toast } from '../../stores/toast-store'
import { Button } from '../ui/button'

type AiItem = Extract<AssistantItem, { kind: 'ai' }>

const ROW_ICONS = { folder: FolderPlus, move: ArrowRight, rename: PenLine, reserve: CalendarClock }

function cents(dollars: number): string {
  const c = dollars * 100
  return c < 0.1 ? '0.1센트 미만' : '약 ' + (c < 10 ? c.toFixed(1) : Math.round(c)) + '센트'
}

function Names({ names }: { names: string[] }): React.JSX.Element | null {
  const [all, setAll] = useState(false)
  if (!names.length) return null
  const shown = all ? names : names.slice(0, 5)
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {shown.map((n, i) => (
        <span
          key={i}
          className="max-w-full truncate rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted"
        >
          {n}
        </span>
      ))}
      {names.length > 5 && (
        <button className="px-1 text-[11px] font-semibold text-accent" onClick={() => setAll(!all)}>
          {all ? '접기' : '외 ' + (names.length - 5) + '개 펼치기'}
        </button>
      )}
    </div>
  )
}

function PlanCard({ item }: { item: AiItem }): React.JSX.Element | null {
  const run = useAssistantStore((s) => s.run)
  const cancel = useAssistantStore((s) => s.cancel)
  const revert = useAssistantStore((s) => s.revert)
  const canUndo = useAssistantStore((s) => !!s.undo[item.id])
  if (!item.plan) return null
  const state = item.planState
  const done = state === 'done'
  const badge =
    state === 'ready'
      ? '실행 전'
      : state === 'running'
        ? '실행 중'
        : state === 'done'
          ? '완료'
          : state === 'failed'
            ? '멈춤'
            : state === 'undone'
              ? '되돌림'
              : '취소'
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <span className="min-w-0 truncate text-[13px] font-semibold text-ink">
          {item.plan.summary}
        </span>
        <span className="shrink-0 text-[11.5px] text-faint">{item.rows.length}단계</span>
        <span
          className={cn(
            'ml-auto shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold',
            state === 'failed'
              ? 'bg-danger/10 text-danger'
              : state === 'cancelled' || state === 'undone'
                ? 'bg-surface-2 text-muted'
                : 'bg-accent-soft text-accent'
          )}
        >
          {badge}
        </span>
      </div>
      <div className="max-h-[280px] overflow-y-auto">
        {item.rows.map((row: PlanRow, i) => {
          const Icon = done ? Check : ROW_ICONS[row.kind]
          return (
            <div
              key={i}
              className="flex items-start gap-2.5 border-t border-line px-3.5 py-2.5 first:border-t-0"
            >
              <span
                className={cn(
                  'grid size-[22px] shrink-0 place-items-center rounded-md',
                  done ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted'
                )}
              >
                <Icon size={13} />
              </span>
              <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink">
                {row.lead} <b className="font-semibold">{row.strong}</b> {row.tail}
                <Names names={row.names} />
              </div>
            </div>
          )
        })}
      </div>
      {(item.plan.note || item.result) && (
        <div className="flex items-start gap-1.5 border-t border-line bg-surface-2/50 px-3.5 py-2 text-[11.5px] leading-relaxed text-muted">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>{item.result ?? item.plan.note}</span>
        </div>
      )}
      {(state === 'ready' || state === 'running' || canUndo) && (
        <div className="flex items-center gap-1.5 border-t border-line px-3 py-2.5">
          {state === 'ready' || state === 'running' ? (
            <>
              <Button
                size="sm"
                variant="accent"
                loading={state === 'running'}
                onClick={() => void run(item.id)}
              >
                <Check size={13} />
                실행
              </Button>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                disabled={state === 'running'}
                onClick={() => cancel(item.id)}
              >
                취소
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => void revert(item.id)}>
              <Undo2 size={13} />
              되돌리기
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function DraftCards({ item }: { item: AiItem }): React.JSX.Element | null {
  const insert = useAssistantStore((s) => s.insertDraft)
  const revert = useAssistantStore((s) => s.revert)
  const canUndo = useAssistantStore((s) => !!s.undo[item.id])
  if (!item.drafts.length) return null
  return (
    <div className="flex flex-col gap-2">
      {item.drafts.map((d, i) => (
        <div key={i} className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
            <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{d.title}</span>
            {item.inserted === i && (
              <span className="ml-auto shrink-0 rounded-md bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">
                입력칸에 넣음
              </span>
            )}
          </div>
          <pre className="m-3 max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-ink select-text">
            {d.prompt}
          </pre>
          <div className="flex items-center gap-1.5 border-t border-line px-3 py-2.5">
            <Button
              size="sm"
              variant={item.inserted === i ? 'default' : 'tint'}
              onClick={() => insert(item.id, i)}
            >
              입력칸에 넣기
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard
                  .writeText(d.prompt)
                  .then(() => toast('프롬프트를 복사했어요', 'success'))
              }}
            >
              <Copy size={13} />
              복사
            </Button>
            <span className="flex-1" />
            {item.inserted === i && canUndo && (
              <Button size="sm" variant="ghost" onClick={() => void revert(item.id)}>
                <Undo2 size={13} />
                입력칸 되돌리기
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function Conversation(): React.JSX.Element {
  const items = useAssistantStore((s) => s.items)
  const busy = useAssistantStore((s) => s.busy)
  const model = useAssistantStore((s) => s.status?.model ?? 'sonnet')
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [items.length, busy])
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
      {items.map((it) =>
        it.kind === 'user' ? (
          <div
            key={it.id}
            className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent-soft px-3 py-2 text-[13px] leading-relaxed text-ink"
          >
            {it.text}
          </div>
        ) : it.kind === 'error' ? (
          <div
            key={it.id}
            className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-danger"
          >
            <Info size={14} className="mt-0.5 shrink-0" />
            {it.text}
          </div>
        ) : (
          <div key={it.id} className="flex flex-col gap-2.5">
            {it.trace.length > 0 && (
              <div className="flex flex-col gap-1">
                {it.trace.map((t, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-[12px] text-muted">
                    <Check size={13} className="text-accent" />
                    {t}
                  </div>
                ))}
              </div>
            )}
            {it.text && (
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink select-text">
                {it.text}
              </p>
            )}
            <PlanCard item={it} />
            <DraftCards item={it} />
            <p className="flex items-center gap-1 text-[11px] text-faint">
              {ASSISTANT_MODELS[model].label} · {cents(it.cost)}
            </p>
          </div>
        )
      )}
      {busy && (
        <div className="flex items-center gap-2 text-[12.5px] text-muted">
          <Loader2 size={14} className="animate-spin" />
          생각하는 중…
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}

function DoneBar(): React.JSX.Element | null {
  const items = useAssistantStore((s) => s.items)
  const undo = useAssistantStore((s) => s.undo)
  const revert = useAssistantStore((s) => s.revert)
  const expand = useAssistantStore((s) => s.expand)
  const last = [...items].reverse().find((it): it is AiItem => it.kind === 'ai')
  let text = '대화를 접어 뒀어요'
  if (last?.plan && last.result) text = last.result
  else if (last && last.inserted !== null)
    text = '"' + last.drafts[last.inserted].title + '"을(를) GPT 입력칸에 넣었어요'
  const canUndo = !!last && !!undo[last.id]
  return (
    <div className="mx-2.5 flex items-center gap-2.5 rounded-t-xl border border-b-0 border-line bg-surface px-3.5 py-2 shadow-xl">
      <span className="grid size-[22px] shrink-0 place-items-center rounded-md bg-accent-soft text-accent">
        <Check size={13} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{text}</span>
      {canUndo && last && (
        <Button size="sm" onClick={() => void revert(last.id)}>
          <Undo2 size={13} />
          되돌리기
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={expand}>
        대화 펼치기
      </Button>
    </div>
  )
}

function Composer(): React.JSX.Element {
  const status = useAssistantStore((s) => s.status)
  const busy = useAssistantStore((s) => s.busy)
  const hasItems = useAssistantStore((s) => s.items.length > 0)
  const focusTick = useAssistantStore((s) => s.focusTick)
  const ask = useAssistantStore((s) => s.ask)
  const setOpen = useAssistantStore((s) => s.setOpen)
  const view = useLayoutStore((s) => s.centerMode)
  const openSettingsAt = useLayoutStore((s) => s.openSettingsAt)
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [focusTick])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [text])

  const send = (): void => {
    if (!text.trim() || busy || !status?.claudeReady) return
    void ask(text)
    setText('')
  }

  return (
    <div className="rounded-2xl border border-line bg-surface shadow-xl transition-colors focus-within:border-accent/55">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
        placeholder={
          hasItems ? '이어서 말하기…' : '무엇을 할까요? 예) 오프파코 씬들 캐릭터별로 폴더 나눠줘'
        }
        className="block max-h-40 min-h-[44px] w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1">
        <span className="inline-flex h-[26px] min-w-0 shrink-0 items-center gap-1 rounded-md bg-surface-2 px-2 text-[11.5px] font-semibold text-muted">
          <Eye size={12} />
          지금 화면 · {viewLabel(view)}
        </span>
        {!!status?.guideChars && (
          <span
            title={'지침: ' + status.guideName + ' (' + status.guideChars.toLocaleString() + '자)'}
            className="inline-flex h-[26px] min-w-0 items-center gap-1 rounded-md bg-accent-soft px-2 text-[11.5px] font-semibold text-accent"
          >
            <BookText size={12} className="shrink-0" />
            <span className="truncate">지침 · {status.guideName}</span>
          </span>
        )}
        <span className="flex-1" />
        {status && !status.claudeReady ? (
          <Button size="sm" variant="tint" onClick={() => openSettingsAt('assistant')}>
            Claude 키 넣기
          </Button>
        ) : (
          <>
            <span className="shrink-0 text-[11.5px] font-semibold text-muted">
              {ASSISTANT_MODELS[status?.model ?? 'sonnet'].label}
            </span>
            <span className="shrink-0 rounded border border-line px-1.5 text-[10.5px] font-semibold text-faint">
              Ctrl K
            </span>
            <button
              title="보내기 (Enter)"
              disabled={!text.trim() || busy}
              onClick={send}
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-white transition-opacity disabled:bg-surface-2 disabled:text-faint dark:text-paper"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={16} />}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function AssistantDock(): React.JSX.Element | null {
  const status = useAssistantStore((s) => s.status)
  const open = useAssistantStore((s) => s.open)
  const minimized = useAssistantStore((s) => s.minimized)
  const items = useAssistantStore((s) => s.items)
  const loadStatus = useAssistantStore((s) => s.loadStatus)
  const setOpen = useAssistantStore((s) => s.setOpen)
  const reset = useAssistantStore((s) => s.reset)
  const settingsOpen = useLayoutStore((s) => s.settingsOpen)

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])
  // 설정에서 키·지침을 바꾸고 닫으면 다시 읽는다
  useEffect(() => {
    if (!settingsOpen) void loadStatus()
  }, [settingsOpen, loadStatus])

  if (!open) {
    if (status && !status.showDock) return null
    return (
      <button
        onClick={() => setOpen(true)}
        title="AI 비서 (Ctrl+K)"
        className="absolute bottom-3 left-1/2 z-30 inline-flex h-9 -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-semibold text-muted shadow-sm transition-colors hover:text-ink"
      >
        <Sparkles size={14} className="text-accent" />
        AI 비서
        <span className="rounded border border-line px-1.5 text-[10.5px] text-faint">Ctrl K</span>
      </button>
    )
  }

  const firstUser = items.find((it) => it.kind === 'user')
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-5">
      <div className="pointer-events-auto flex w-full max-w-[680px] flex-col">
        {items.length > 0 && !minimized && (
          <div className="mx-2.5 flex max-h-[min(580px,calc(100vh-230px))] min-h-0 flex-col rounded-t-2xl border border-b-0 border-line bg-surface shadow-xl">
            <div className="flex items-center gap-2 border-b border-line py-2.5 pl-4 pr-2.5">
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-accent">
                <Sparkles size={13} />
              </span>
              <b className="shrink-0 text-[13.5px] font-semibold text-ink">AI 비서</b>
              <span className="min-w-0 truncate text-[11.5px] text-faint">
                {firstUser?.kind === 'user' ? firstUser.text : ''}
              </span>
              <span className="ml-auto flex shrink-0 gap-0.5">
                <Button size="icon-sm" variant="ghost" title="새 대화" onClick={reset}>
                  <Plus size={15} />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="접기"
                  onClick={() => useAssistantStore.setState({ minimized: true })}
                >
                  <ChevronDown size={15} />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="닫기 (Esc)"
                  onClick={() => setOpen(false)}
                >
                  <X size={15} />
                </Button>
              </span>
            </div>
            <Conversation />
          </div>
        )}
        {items.length > 0 && minimized && <DoneBar />}
        <Composer />
      </div>
    </div>
  )
}
