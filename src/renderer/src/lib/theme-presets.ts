import { luminance, mixHex } from './color'

export type ThemeMode = 'dark' | 'light'

export interface Palette {
  neutral: string
  ink: string
  primary: string
  accent: string
  success: string
  warning: string
  error: string
  info: string
  syntaxKeyword: string
  syntaxComment: string
  /** 선택: 창 바탕(paper) 위에 올라가는 카드 면. 지정하면 계산값 대신 이 색을 쓴다. */
  surface?: string
  surface2?: string
  line?: string
  /** 선택: 직접 지정하면 계산값 대신 쓴다 (Atelier 기본 테마) */
  surface3?: string
  muted?: string
  faint?: string
  imageBg?: string
  /** 작은 글자·테두리용 강조색 (없으면 primary) */
  accentText?: string
  /** 밑줄·진행 막대·고른 테두리 (없으면 primary) */
  mark?: string
  /** 강조색 채움 위 글자 (없으면 밝기로 고름) */
  onAccent?: string
  /** 상태 채움(빨강 단추). 없으면 error */
  errorFill?: string
}

export interface ThemePreset {
  id: string
  name: string
  dark?: Palette
  light?: Palette
}

export function buildWhimsTokens(palette: Palette, mode: ThemeMode): Record<string, string> {
  const dark = mode === 'dark'
  const m = (amount: number): string => mixHex(palette.neutral, palette.ink, amount)
  const dim = (amount: number): string => mixHex(palette.ink, palette.neutral, amount)
  const soft = (color: string, pct: number): string =>
    `color-mix(in srgb, ${color} ${pct}%, transparent)`
  const surface2 = palette.surface2 ?? m(dark ? 0.095 : 0.08)
  const accentText = palette.accentText ?? palette.primary
  const onAccent =
    palette.onAccent ?? (luminance(palette.primary) > 0.45 ? palette.neutral : '#ffffff')

  return {
    '--paper': palette.neutral,
    '--surface': palette.surface ?? m(dark ? 0.045 : 0.035),
    '--surface-2': surface2,
    '--surface-3': palette.surface3 ?? m(dark ? 0.15 : 0.13),
    '--image-bg': palette.imageBg ?? surface2,
    '--ink': palette.ink,
    '--muted': palette.muted ?? dim(dark ? 0.42 : 0.46),
    '--faint': palette.faint ?? dim(dark ? 0.62 : 0.58),
    '--line': palette.line ?? m(dark ? 0.14 : 0.16),
    '--accent': palette.primary,
    '--on-accent': onAccent,
    '--accent-text': accentText,
    '--mark': palette.mark ?? palette.primary,
    '--accent-soft': soft(palette.primary, dark ? 14 : 12),
    '--good': palette.success,
    '--warn': palette.warning,
    '--warn-soft': soft(palette.warning, 14),
    '--bad': palette.error,
    '--bad-fill': palette.errorFill ?? palette.error,
    '--bad-soft': soft(palette.error, dark ? 14 : 12),
    '--info': palette.info,
    '--danger': palette.error,
    '--dialogue': accentText,
    '--dialogue-bg': soft(palette.primary, 16),
    '--quote': palette.warning,
    '--quote-bg': soft(palette.warning, 16),
    '--onomatopoeia': palette.accent
  }
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    // Atelier 기본 테마 (토스 색) — id는 저장된 설정이 그대로 맞도록 'nais3'을 유지한다.
    id: 'nais3',
    name: 'Atelier',
    dark: {
      neutral: '#17171c',
      ink: '#e4e4e5',
      primary: '#3182f6',
      accent: '#4593fc',
      success: '#15c47e',
      warning: '#ffa927',
      error: '#f66570',
      info: '#4593fc',
      syntaxKeyword: '#9e9ea4',
      syntaxComment: '#7e7e87',
      surface: '#1f1f25',
      surface2: '#2c2c35',
      surface3: '#3a3a45',
      line: '#2f2f38',
      muted: '#9e9ea4',
      faint: '#7e7e87',
      imageBg: '#2c2c35',
      accentText: '#4593fc',
      mark: '#4593fc',
      onAccent: '#ffffff',
      errorFill: '#f04452'
    },
    light: {
      neutral: '#f2f4f6',
      ink: '#191f28',
      primary: '#3182f6',
      accent: '#1b64da',
      success: '#029359',
      warning: '#b35c00',
      error: '#d22030',
      info: '#1b64da',
      syntaxKeyword: '#4e5968',
      syntaxComment: '#6b7684',
      surface: '#ffffff',
      surface2: '#f2f4f6',
      surface3: '#e5e8eb',
      line: '#e5e8eb',
      muted: '#4e5968',
      faint: '#6b7684',
      imageBg: '#e5e8eb',
      accentText: '#1b64da',
      mark: '#3182f6',
      onAccent: '#ffffff',
      errorFill: '#f04452'
    }
  },
  {
    id: 'tokyonight',
    name: 'Tokyo Night',
    dark: { neutral: '#1a1b26', ink: '#c0caf5', primary: '#7aa2f7', accent: '#ff9e64', success: '#9ece6a', warning: '#e0af68', error: '#f7768e', info: '#7dcfff', syntaxKeyword: '#bb9af7', syntaxComment: '#565f89' },
    light: { neutral: '#e1e2e7', ink: '#273153', primary: '#2e7de9', accent: '#b15c00', success: '#587539', warning: '#8c6c3e', error: '#c94060', info: '#007197', syntaxKeyword: '#9854f1', syntaxComment: '#6b6f7a' }
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    dark: { neutral: '#1e1e2e', ink: '#cdd6f4', primary: '#b4befe', accent: '#f38ba8', success: '#a6d189', warning: '#f4b8e4', error: '#f38ba8', info: '#89dceb', syntaxKeyword: '#cba6f7', syntaxComment: '#6c7086' },
    light: { neutral: '#f5e0dc', ink: '#4c4f69', primary: '#7287fd', accent: '#d20f39', success: '#40a02b', warning: '#df8e1d', error: '#d20f39', info: '#04a5e5', syntaxKeyword: '#8839ef', syntaxComment: '#6c7086' }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    dark: { neutral: '#1d1e28', ink: '#f8f8f2', primary: '#bd93f9', accent: '#ff79c6', success: '#50fa7b', warning: '#ffb86c', error: '#ff5555', info: '#8be9fd', syntaxKeyword: '#ff79c6', syntaxComment: '#6272a4' },
    light: { neutral: '#f8f8f2', ink: '#1f1f2f', primary: '#7c6bf5', accent: '#d16090', success: '#2fbf71', warning: '#f7a14d', error: '#d9536f', info: '#1d7fc5', syntaxKeyword: '#d16090', syntaxComment: '#7d7f97' }
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    dark: { neutral: '#282c34', ink: '#abb2bf', primary: '#61afef', accent: '#56b6c2', success: '#98c379', warning: '#e5c07b', error: '#e06c75', info: '#d19a66', syntaxKeyword: '#c678dd', syntaxComment: '#5c6370' },
    light: { neutral: '#fafafa', ink: '#383a42', primary: '#4078f2', accent: '#0184bc', success: '#50a14f', warning: '#c18401', error: '#e45649', info: '#986801', syntaxKeyword: '#a626a4', syntaxComment: '#a0a1a7' }
  },
  {
    id: 'nord',
    name: 'Nord',
    dark: { neutral: '#2e3440', ink: '#e5e9f0', primary: '#88c0d0', accent: '#d57780', success: '#a3be8c', warning: '#d08770', error: '#bf616a', info: '#81a1c1', syntaxKeyword: '#81a1c1', syntaxComment: '#616e88' },
    light: { neutral: '#eceff4', ink: '#2e3440', primary: '#5e81ac', accent: '#bf616a', success: '#8fbcbb', warning: '#d08770', error: '#bf616a', info: '#81a1c1', syntaxKeyword: '#5e81ac', syntaxComment: '#6b7282' }
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    dark: { neutral: '#282828', ink: '#ebdbb2', primary: '#83a598', accent: '#fb4934', success: '#b8bb26', warning: '#fabd2f', error: '#fb4934', info: '#d3869b', syntaxKeyword: '#fb4934', syntaxComment: '#928374' },
    light: { neutral: '#fbf1c7', ink: '#3c3836', primary: '#076678', accent: '#9d0006', success: '#79740e', warning: '#b57614', error: '#9d0006', info: '#8f3f71', syntaxKeyword: '#9d0006', syntaxComment: '#928374' }
  },
  {
    id: 'github',
    name: 'GitHub',
    dark: { neutral: '#0d1117', ink: '#c9d1d9', primary: '#58a6ff', accent: '#39c5cf', success: '#3fb950', warning: '#e3b341', error: '#f85149', info: '#d29922', syntaxKeyword: '#ff7b72', syntaxComment: '#8b949e' },
    light: { neutral: '#ffffff', ink: '#24292f', primary: '#0969da', accent: '#1b7c83', success: '#1a7f37', warning: '#9a6700', error: '#cf222e', info: '#bc4c00', syntaxKeyword: '#cf222e', syntaxComment: '#57606a' }
  },
  {
    id: 'rosepine',
    name: 'Rose Pine',
    dark: { neutral: '#191724', ink: '#e0def4', primary: '#9ccfd8', accent: '#ebbcba', success: '#31748f', warning: '#f6c177', error: '#eb6f92', info: '#9ccfd8', syntaxKeyword: '#31748f', syntaxComment: '#6e6a86' },
    light: { neutral: '#faf4ed', ink: '#575279', primary: '#31748f', accent: '#d7827e', success: '#286983', warning: '#ea9d34', error: '#b4637a', info: '#56949f', syntaxKeyword: '#286983', syntaxComment: '#9893a5' }
  },
  {
    id: 'solarized',
    name: 'Solarized',
    dark: { neutral: '#002b36', ink: '#93a1a1', primary: '#6c71c4', accent: '#d33682', success: '#859900', warning: '#b58900', error: '#dc322f', info: '#2aa198', syntaxKeyword: '#859900', syntaxComment: '#586e75' },
    light: { neutral: '#fdf6e3', ink: '#586e75', primary: '#268bd2', accent: '#d33682', success: '#859900', warning: '#b58900', error: '#dc322f', info: '#2aa198', syntaxKeyword: '#728600', syntaxComment: '#657b83' }
  },
  {
    id: 'kanagawa',
    name: 'Kanagawa',
    dark: { neutral: '#1f1f28', ink: '#dcd7ba', primary: '#7e9cd8', accent: '#d27e99', success: '#98bb6c', warning: '#d7a657', error: '#e82424', info: '#76946a', syntaxKeyword: '#957fb8', syntaxComment: '#727169' },
    light: { neutral: '#f2e9de', ink: '#54433a', primary: '#2d4f67', accent: '#d27e99', success: '#98bb6c', warning: '#d7a657', error: '#e82424', info: '#76946a', syntaxKeyword: '#957fb8', syntaxComment: '#9e9389' }
  },
  {
    id: 'vercel',
    name: 'Vercel',
    dark: { neutral: '#000000', ink: '#ededed', primary: '#0070f3', accent: '#8e4ec6', success: '#46a758', warning: '#ffb224', error: '#e5484d', info: '#52a8ff', syntaxKeyword: '#f75590', syntaxComment: '#878787' },
    light: { neutral: '#ffffff', ink: '#171717', primary: '#0070f3', accent: '#8e4ec6', success: '#388e3c', warning: '#ff9500', error: '#dc3545', info: '#0070f3', syntaxKeyword: '#e93d82', syntaxComment: '#888888' }
  }
]

export function getThemePreset(id: string): ThemePreset {
  return THEME_PRESETS.find((preset) => preset.id === id) ?? THEME_PRESETS[0]
}
