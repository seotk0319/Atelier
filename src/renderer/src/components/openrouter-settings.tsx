import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { OpenRouterStatus } from '@shared/llm'
import { cn } from '../lib/utils'
import { askConfirm } from '../stores/dialog-store'
import { Button } from './ui/button'
import { Input } from './ui/input'

const dollar = (value: number): string =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 설정 > AI 도우미. OpenRouter 키 하나로 댓글 번역(DeepSeek)과 태그 도우미를 함께 쓴다. */
export function OpenRouterSection(): React.JSX.Element {
  const [status, setStatus] = useState<OpenRouterStatus | null>(null)
  const [usage, setUsage] = useState<{ usage: number | null; limit: number | null } | null>(null)
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null)
  const connected = !!status?.hasKey

  const load = async (): Promise<void> => {
    setStatus(await window.nais.invoke('openrouter:status', undefined))
  }

  useEffect(() => {
    void load().catch(() => setStatus({ hasKey: false, tail: '' }))
  }, [])

  async function save(): Promise<void> {
    if (!key.trim() || busy) return
    setBusy(true)
    setNote(null)
    try {
      const result = await window.nais.invoke('openrouter:setKey', { key })
      setNote(result)
      if (result.ok) {
        setKey('')
        setEditing(false)
        setUsage({ usage: result.usage ?? null, limit: result.limit ?? null })
        await load()
      }
    } catch {
      setNote({ ok: false, message: '키를 저장하지 못했어요. 다시 시도해주세요.' })
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    const ok = await askConfirm('OpenRouter 연결을 해제할까요?', {
      message: '저장한 키를 지워요. 댓글 번역과 AI 태그 도우미가 함께 멈춰요.',
      confirmLabel: '해제',
      danger: true
    })
    if (!ok) return
    await window.nais.invoke('openrouter:deleteKey', undefined)
    setUsage(null)
    setNote(null)
    setEditing(false)
    setKey('')
    await load()
  }

  return (
    <div>
      <p className="mb-4 text-[12px] leading-relaxed text-faint">
        OpenRouter 키 하나로 DeepSeek V4.1 Flash를 써서 댓글 번역(DeepSeek 엔진)과 AI 태그 도우미를
        돌려요. 키는 OS 암호화로 저장해요.
      </p>
      {connected && !editing ? (
        <div className="rounded-xl border border-line p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
              <Sparkles size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-ink">OpenRouter 연결됨</p>
              <p className="mt-0.5 font-mono text-[12px] text-faint">••••••{status?.tail}</p>
            </div>
          </div>
          {usage && usage.usage !== null && (
            <div className="mt-4 flex items-baseline justify-between text-[12px]">
              <span className="text-muted">키 사용액</span>
              <span className="tabular-nums text-ink">
                ${dollar(usage.usage)}
                {usage.limit !== null && ` / ${dollar(usage.limit)}`}
              </span>
            </div>
          )}
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
            placeholder="OpenRouter API 키 붙여넣기"
            aria-label="OpenRouter API 키"
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
          <p className="text-[12px] leading-relaxed text-faint">
            키가 없다면{' '}
            <button
              className="font-medium text-accent hover:underline"
              onClick={() => window.open('https://openrouter.ai/keys', '_blank')}
            >
              OpenRouter 키 만들기
            </button>
            에서 받을 수 있어요. 댓글 번역과 태그 도우미가 같은 키를 써요.
          </p>
        </div>
      )}
      {note && (
        <p className={cn('mt-3 text-[12px]', note.ok ? 'text-accent' : 'text-danger')}>
          {note.message}
        </p>
      )}
    </div>
  )
}
