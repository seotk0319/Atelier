// OpenRouter 키 저장·상태. 화면에는 끝 6자리만 보낸다.
import type { OpenRouterKeyResult, OpenRouterStatus } from '../../shared/llm'
import { deleteOpenRouterKey, getOpenRouterKey, setOpenRouterKey } from '../db/settings'
import { openRouterMessage, openrouterKeyInfo } from './openrouter'

export function openRouterStatus(): OpenRouterStatus {
  const key = getOpenRouterKey()
  return key ? { hasKey: true, tail: key.slice(-6) } : { hasKey: false, tail: '' }
}

export async function saveOpenRouterKey(raw: string): Promise<OpenRouterKeyResult> {
  const key = String(raw || '').trim()
  if (!key || key.length > 300 || /\s/.test(key))
    return { ok: false, message: 'OpenRouter API 키 모양이 아니에요. 다시 붙여넣어 주세요.' }
  try {
    const info = await openrouterKeyInfo(key)
    setOpenRouterKey(key)
    return { ok: true, message: '키를 확인하고 저장했어요.', ...info }
  } catch (error) {
    return { ok: false, message: openRouterMessage(error) }
  }
}

export function removeOpenRouterKey(): { ok: true } {
  deleteOpenRouterKey()
  return { ok: true }
}
