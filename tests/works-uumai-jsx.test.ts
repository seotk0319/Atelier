import { describe, expect, it } from 'vitest'
import { compileUumaiJsx } from '../src/main/works/uumai-jsx'

const SOURCE = `import { Check } from 'lucide-react'
import React from 'react'

const IMG = 'https://example.com/'
const ORDER = ['a', 'b']
// helper names start lowercase so they are not taken for components
function plain(s) { return String(s || '') }
const Chip = ({ label }) => <span className="chip">{label}</span>

function Card({ title = '…', items = [] }) {
  const [open, setOpen] = useState(false)
  return (
    <div onClick={() => setOpen(!open)}>
      <Check className="h-4 w-4" />
      <p>{plain(title)}</p>
      {open && items.map((x) => <Chip key={x} label={x} />)}
      <img src={IMG + ORDER[0]} alt="" />
    </div>
  )
}
`

describe('우마이 JSX 컴파일', () => {
  it('편집기와 같은 모양으로 컴파일한다', () => {
    const out = compileUumaiJsx('Card', SOURCE)
    expect(out.fileName).toBe('Card')
    expect(out.sourceCode).toBe(SOURCE)
    // 맨 위의 대문자로 시작하는 함수·화살표 함수만 컴포넌트다 (문자열·배열 상수와 소문자 도우미는 아니다)
    expect(out.components.sort()).toEqual(['Card', 'Chip'])
    expect(
      out.compiledCode.startsWith("import React from 'react'; const { useState, useEffect,")
    ).toBe(true)
    // 소스의 react import는 지우고, lucide는 채팅 화면이 쓰는 주소로 바꾼다
    expect(out.compiledCode.match(/from ['"]react['"]/g)).toHaveLength(1)
    expect(out.compiledCode).toContain("from 'https://esm.sh/lucide-react@0.554.0?external=react'")
    expect(out.compiledCode).toContain('React.createElement(')
    expect(out.compiledCode).not.toContain('<div')
    expect(out.compiledCode.trimEnd().endsWith('export {Chip,Card};')).toBe(true)
  })

  it('이미 export한 컴포넌트는 끝의 export 줄에 다시 넣지 않는다', () => {
    const out = compileUumaiJsx(
      '두개',
      'export function A() { return <b /> }\nfunction B() { return <i /> }\n'
    )
    expect(out.components.sort()).toEqual(['A', 'B'])
    expect(out.compiledCode.trimEnd().endsWith('export {B};')).toBe(true)
  })

  it('이름·문법·빈 파일을 막는다', () => {
    expect(() => compileUumaiJsx('a b', 'function A() { return <b /> }')).toThrow('BAD_JSX name')
    expect(() => compileUumaiJsx('A', '   ')).toThrow('BAD_JSX size')
    expect(() => compileUumaiJsx('A', 'function A() { return <b> }')).toThrow('BAD_JSX A')
    expect(() => compileUumaiJsx('A', 'function a() { return 1 }')).toThrow(
      'BAD_JSX A no component'
    )
  })
})
