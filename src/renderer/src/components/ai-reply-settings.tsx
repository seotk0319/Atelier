import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AI_DAILY_LIMITS, type AiLogEntry, type AiReplyMode } from '@shared/ai-reply'
import { INBOX_PLATFORMS, type InboxPlatform } from '@shared/inbox'
import { cn } from '../lib/utils'
import { useAiReplyStore } from '../stores/ai-reply-store'
import { askConfirm } from '../stores/dialog-store'
import { Button } from './ui/button'
import { Input } from './ui/input'

const MODES: { id: AiReplyMode; label: string; hint: string }[] = [
  { id: 'off', label: '끄기', hint: '새 댓글이 와도 아무것도 하지 않아요.' },
  { id: 'draft', label: '초안만', hint: '새 댓글에 답글 초안만 채워 두고, 보내기는 직접 눌러요.' },
  {
    id: 'send',
    label: '자동 보내기',
    hint: '새 댓글에 감사 답글을 자동으로 달아요. 문의·불만·버그 제보는 넘겨요.'
  }
]
const STATE_LABELS: Record<AiLogEntry['state'], string> = {
  sent: '보냄',
  drafted: '초안',
  skipped: '넘김',
  failed: '실패'
}
const STATE_TONES: Record<AiLogEntry['state'], string> = {
  sent: 'bg-accent-soft text-accent',
  drafted: 'bg-surface-2 text-ink',
  skipped: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  failed: 'bg-danger/10 text-danger'
}
const clock = (value: string | null): string =>
  value
    ? new Date(value).toLocaleString('ko-KR', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : ''
const dollars = (value: number): string =>
  value < 0.01 ? '$' + value.toFixed(4) : '$' + value.toFixed(2)

/** 설정 > AI 답글. Claude 키를 확인해 저장하고, 자동 답글 모드와 최근 기록을 보여준다. */
export function AiReplySection(): React.JSX.Element {
  const status = useAiReplyStore((s) => s.status)
  const load = useAiReplyStore((s) => s.load)
  const setConfig = useAiReplyStore((s) => s.setConfig)
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null)
  const [log, setLog] = useState<AiLogEntry[]>([])
  const connected = !!status?.hasKey
  const config = status?.config

  useEffect(() => {
    void load()
    void window.nais
      .invoke('aiReply:log', { limit: 15 })
      .then(setLog)
      .catch(() => setLog([]))
  }, [load])

  async function save(): Promise<void> {
    if (!key.trim() || busy) return
    setBusy(true)
    setNote(null)
    try {
      const result = await window.nais.invoke('aiReply:setKey', { key })
      setNote(result)
      if (result.ok) {
        setKey('')
        setEditing(false)
        await load()
      }
    } catch {
      setNote({ ok: false, message: '키를 저장하지 못했어요. 다시 시도해주세요.' })
    } finally {
      setBusy(false)
    }
  }
  async function remove(): Promise<void> {
    const ok = await askConfirm('Claude 연결을 해제할까요?', {
      message: '저장한 키를 지워요. 자동 답글도 멈춰요.',
      confirmLabel: '해제',
      danger: true
    })
    if (!ok) return
    await window.nais.invoke('aiReply:deleteKey', undefined)
    await setConfig({ mode: 'off' })
    setNote(null)
    await load()
  }
  function togglePlatform(id: InboxPlatform): void {
    if (!config) return
    const excluded = config.excluded.includes(id)
      ? config.excluded.filter((p) => p !== id)
      : [...config.excluded, id]
    void setConfig({ excluded })
  }

  const mode = MODES.find((m) => m.id === (config?.mode ?? 'off')) ?? MODES[0]

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="mb-4 text-[12px] leading-relaxed text-faint">
          알림 모아보기에서 답글 초안을 쓰거나 새 댓글에 자동으로 답글을 달 때 Claude Haiku 5.5를
          써요. 댓글과 지난 답글 예시만 보내요.
        </p>
        {connected && !editing ? (
          <div className="rounded-xl border border-line p-4">
            <div className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                <Sparkles size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold text-ink">Claude 연결됨</p>
                <p className="mt-0.5 text-[11.5px] text-faint">Haiku 5.5 · 키 끝 {status?.tail}</p>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]">
              <dt className="text-muted">이번 달 (NAIS3에서 쓴 만큼)</dt>
              <dd className="text-right tabular-nums text-ink">
                {status
                  ? `${dollars(status.usage.cost)} · ${status.usage.requests.toLocaleString()}회`
                  : ''}
              </dd>
              <dt className="text-muted">말투 예시</dt>
              <dd className="text-right tabular-nums text-ink">
                {status
                  ? `지난 답글 ${status.examples.used}개 (전체 ${status.examples.total.toLocaleString()}개)`
                  : ''}
              </dd>
            </dl>
            <div className="mt-4 flex gap-2">
              <Button className="flex-1" onClick={() => setEditing(true)}>
                키 바꾸기
              </Button>
              <Button
                variant="ghost"
                className="text-danger hover:text-danger"
                onClick={() => void remove()}
              >
                연결 해제
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
              placeholder="Claude API 키 붙여넣기 (sk-ant-…)"
              aria-label="Claude API 키"
              className="h-10 rounded-lg"
            />
            <div className="flex gap-2">
              <Button
                variant="accent"
                size="lg"
                className="flex-1"
                disabled={!key.trim() || busy}
                onClick={() => void save()}
              >
                {busy ? '키를 확인하는 중…' : '확인하고 저장'}
              </Button>
              {connected && (
                <Button
                  variant="ghost"
                  size="lg"
                  onClick={() => {
                    setEditing(false)
                    setKey('')
                    setNote(null)
                  }}
                >
                  취소
                </Button>
              )}
            </div>
            <p className="text-[11.5px] leading-relaxed text-faint">
              키는{' '}
              <button
                className="font-medium text-accent hover:underline"
                onClick={() => window.open('https://platform.claude.com/settings/keys', '_blank')}
              >
                Claude Console API 키
              </button>
              에서 만들 수 있어요.
            </p>
          </div>
        )}
        {note && (
          <p className={cn('mt-3 text-[12px]', note.ok ? 'text-accent' : 'text-danger')}>
            {note.message}
          </p>
        )}
      </div>

      <section
        className={cn('flex flex-col gap-3', !connected && 'pointer-events-none opacity-45')}
      >
        <div className="flex items-center gap-3">
          <h3 className="mr-auto text-[13px] font-semibold text-ink">자동 답글</h3>
          <div
            role="radiogroup"
            aria-label="자동 답글 모드"
            className="flex gap-0.5 rounded-lg bg-surface-2 p-0.5"
          >
            {MODES.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={mode.id === m.id}
                disabled={!connected}
                onClick={() => void setConfig({ mode: m.id })}
                className={cn(
                  'h-7 whitespace-nowrap rounded-md px-3 text-[12px] font-semibold transition-colors',
                  mode.id === m.id ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[11.5px] leading-relaxed text-muted">
          {mode.hint}
          {config?.since && (
            <span className="text-faint"> 켠 뒤({clock(config.since)})에 온 댓글만 다뤄요.</span>
          )}
        </p>
        {status && config?.mode !== 'off' && (
          <p className="text-[12px] tabular-nums text-ink">
            오늘 보냄 {status.today.sent} · 초안 {status.today.drafted} · 넘김{' '}
            {status.today.skipped}
            {status.today.failed > 0 && (
              <span className="text-danger"> · 실패 {status.today.failed}</span>
            )}
          </p>
        )}
        {status?.lastError && (
          <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {status.lastError}
          </p>
        )}
        <label className="flex items-center justify-between gap-3 text-[12px] text-muted">
          하루 최대 자동 답글
          <select
            aria-label="하루 최대 자동 답글"
            value={config?.dailyLimit ?? 50}
            disabled={!connected}
            onChange={(e) => void setConfig({ dailyLimit: Number(e.target.value) })}
            className="rounded-lg border border-line bg-paper px-2 py-1.5 text-ink"
          >
            {AI_DAILY_LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}개
              </option>
            ))}
          </select>
        </label>
        <div>
          <p className="mb-2 text-[12px] text-muted">다룰 플랫폼</p>
          <div className="grid grid-cols-3 gap-1.5">
            {(Object.keys(INBOX_PLATFORMS) as InboxPlatform[]).map((id) => {
              const on = !config?.excluded.includes(id)
              return (
                <label
                  key={id}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors',
                    on ? 'border-accent/40 bg-accent-soft/50 text-ink' : 'border-line text-muted'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!connected}
                    onChange={() => togglePlatform(id)}
                    className="accent-[var(--accent)]"
                  />
                  {INBOX_PLATFORMS[id]}
                </label>
              )
            })}
          </div>
        </div>
      </section>

      {log.length > 0 && (
        <section>
          <h3 className="mb-2 text-[13px] font-semibold text-ink">최근 자동 답글</h3>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {log.map((entry) => (
              <li key={entry.id} className="px-3 py-2 text-[12px]">
                <p className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      'shrink-0 rounded-md px-1.5 py-px text-[11px] font-semibold',
                      STATE_TONES[entry.state]
                    )}
                  >
                    {STATE_LABELS[entry.state]}
                  </span>
                  <span className="shrink-0 text-muted">
                    {INBOX_PLATFORMS[entry.platform as InboxPlatform] || entry.platform}
                  </span>
                  <span className="min-w-0 truncate text-ink">{entry.comment}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-faint">
                    {clock(entry.at)}
                  </span>
                </p>
                <p className="mt-0.5 truncate text-muted">
                  {entry.content || entry.reason || entry.replies[0] || ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
