// 우마이 JSX 컴포넌트 컴파일. 편집기가 저장할 때 브라우저에서 하는 것(사이트 공개 스크립트 4368 묶음 85530 모듈)을
// 그대로 옮겼다: sucrase로 JSX·TypeScript를 풀고(classic 런타임), acorn으로 맨 위 선언에서 컴포넌트 이름을 찾고,
// react import를 지우고 lucide import를 esm.sh 주소로 바꾼 뒤, 앞에 React 훅 꺼내기 줄을, 뒤에 export 줄을 붙인다.
// 채팅 화면은 이 compiledCode를 파일 이름으로 import해서 컴포넌트 이름으로 꺼내 그린다.
import { parse } from 'acorn'
import { transform } from 'sucrase'

const CDN: Record<string, string> = {
  'lucide-react': 'https://esm.sh/lucide-react@0.554.0?external=react',
  lucide: 'https://esm.sh/lucide@0.554.0?external=react'
}
const HOOKS =
  "import React from 'react'; const { " +
  'useState, useEffect, useRef, useCallback, useMemo, useContext, useReducer, useLayoutEffect, useImperativeHandle, useDebugValue, useId, useSyncExternalStore, useTransition, useDeferredValue, createContext, forwardRef, memo, lazy, Fragment, Suspense, Children, cloneElement, isValidElement, createElement, createRef' +
  ' } = React;'
const COMPONENT_NAME = /^[A-Z][a-zA-Z0-9]*$/
/** 파일 이름 규칙 (저장 본문 규격) */
export const JSX_FILE_NAME = /^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9_-]{1,30}$/
export const JSX_MAX_FILES = 20
export const JSX_MAX_CODE = 1_000_000

type Node = { type: string; [key: string]: unknown }
const FUNCTION_LIKE = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'CallExpression',
  'TaggedTemplateExpression'
])

function patternNames(p: Node | null): string[] {
  if (!p) return []
  switch (p.type) {
    case 'Identifier':
      return [p.name as string]
    case 'ObjectPattern':
      return (p.properties as Node[]).flatMap((q) =>
        q.type === 'RestElement' ? patternNames(q.argument as Node) : patternNames(q.value as Node)
      )
    case 'ArrayPattern':
      return (p.elements as (Node | null)[]).flatMap((q) => patternNames(q))
    case 'RestElement':
      return patternNames(p.argument as Node)
    case 'AssignmentPattern':
      return patternNames(p.left as Node)
    default:
      return []
  }
}

function declared(node: Node): string[] {
  if (node.type === 'VariableDeclaration')
    return (node.declarations as Node[])
      .filter((d) => !d.init || FUNCTION_LIKE.has((d.init as Node).type))
      .flatMap((d) => patternNames(d.id as Node))
  if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id)
    return [(node.id as Node).name as string]
  return []
}

export interface CompiledJsx {
  fileName: string
  sourceCode: string
  compiledCode: string
  components: string[]
}

/** 소스 하나를 컴파일한다. 문법 오류나 컴포넌트가 하나도 없으면 던진다 */
export function compileUumaiJsx(fileName: string, sourceCode: string): CompiledJsx {
  if (!JSX_FILE_NAME.test(fileName)) throw new Error('BAD_JSX name')
  if (!sourceCode.trim() || sourceCode.length > JSX_MAX_CODE) throw new Error('BAD_JSX size')
  let code: string
  let program: Node
  try {
    code = transform(sourceCode, { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code
    program = parse(code, { sourceType: 'module', ecmaVersion: 'latest' }) as unknown as Node
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error('BAD_JSX ' + fileName + ' ' + message.slice(0, 60))
  }
  const exported = new Set<string>()
  const plain = new Set<string>()
  const keep = (into: Set<string>, names: string[]): void => {
    for (const n of names) if (COMPONENT_NAME.test(n)) into.add(n)
  }
  for (const node of program.body as Node[]) {
    if (node.type === 'VariableDeclaration' || node.type === 'FunctionDeclaration')
      keep(plain, declared(node))
    else if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) keep(exported, declared(node.declaration as Node))
      else
        keep(
          exported,
          (node.specifiers as Node[])
            .filter((s) => s.type === 'ExportSpecifier')
            .map((s) => (s.local as Node).name as string)
        )
    } else if (node.type === 'ExportDefaultDeclaration') {
      const d = node.declaration as Node
      keep(plain, d.type === 'Identifier' ? [d.name as string] : declared(d))
    }
  }
  const components = [...new Set([...exported, ...plain])]
  if (!components.length) throw new Error('BAD_JSX ' + fileName + ' no component')
  const body = code
    .replace(
      /import\s+(?:(?:\{[^}]*\}|\w+)(?:\s*,\s*(?:\{[^}]*\}|\w+))*\s+from\s+)?['"]react['"];?\n?/g,
      ''
    )
    .replace(/from\s+['"]([^'"./][^'"]*)['"]/g, (all, name: string) =>
      CDN[name] ? "from '" + CDN[name] + "'" : all
    )
  const unexported = [...plain].filter((n) => !exported.has(n))
  return {
    fileName,
    sourceCode,
    compiledCode: HOOKS + ' ' + body + '\nexport {' + unexported.join(',') + '};',
    components
  }
}
