export type ThemeScheme = 'light' | 'dark'

export interface ThemePreview {
  background: string
  sidebar: string
  surface: string
  accent: string
  ink: string
}

interface ThemeDefinition {
  id: string
  label: `theme.${string}`
  scheme: ThemeScheme
  metaColor: string
  preview: ThemePreview
}

export const themeOptions = [
  {
    id: 'synapse', label: 'theme.synapse', scheme: 'dark', metaColor: '#030303',
    preview: { background: '#030303', sidebar: '#08070d', surface: '#15121f', accent: '#8b5cf6', ink: '#f8f7ff' },
  },
  {
    id: 'zenix', label: 'theme.zenix', scheme: 'dark', metaColor: '#050505',
    preview: { background: '#050505', sidebar: '#0c0c0c', surface: '#262626', accent: '#3b82f6', ink: '#f5f5f4' },
  },
  {
    id: 'swiss', label: 'theme.swiss', scheme: 'light', metaColor: '#f2f2f2',
    preview: { background: '#f2f2f2', sidebar: '#f2f2f2', surface: '#ffffff', accent: '#e6382c', ink: '#111111' },
  },
  {
    id: 'lumina', label: 'theme.lumina', scheme: 'light', metaColor: '#ffe17c',
    preview: { background: '#ffe17c', sidebar: '#b7c6c2', surface: '#fffdf4', accent: '#171e19', ink: '#171e19' },
  },
  {
    id: 'mosaic', label: 'theme.mosaic', scheme: 'light', metaColor: '#f7f7f5',
    preview: { background: '#f7f7f5', sidebar: '#f7f7f5', surface: '#edf1ed', accent: '#1a3c2b', ink: '#1a3c2b' },
  },
  {
    id: 'softly', label: 'theme.softly', scheme: 'light', metaColor: '#fdfcf8',
    preview: { background: '#fdfcf8', sidebar: '#f4f0e8', surface: '#efedf4', accent: '#4e765c', ink: '#20302a' },
  },
  {
    id: 'nature', label: 'theme.nature', scheme: 'light', metaColor: '#efe7d2',
    preview: { background: '#efe7d2', sidebar: '#254031', surface: '#f8f1dd', accent: '#78854b', ink: '#17261c' },
  },
  {
    id: 'blueprint', label: 'theme.blueprint', scheme: 'dark', metaColor: '#003366',
    preview: { background: '#003366', sidebar: '#002b58', surface: '#003d75', accent: '#00e6ff', ink: '#f7fbff' },
  },
  {
    id: 'neumorphism', label: 'theme.neumorphism', scheme: 'light', metaColor: '#e0e5ec',
    preview: { background: '#e0e5ec', sidebar: '#e0e5ec', surface: '#edf1f6', accent: '#315b80', ink: '#263442' },
  },
  {
    id: 'devtools', label: 'theme.devtools', scheme: 'light', metaColor: '#f3f4f6',
    preview: { background: '#f3f4f6', sidebar: '#eef1f4', surface: '#ffffff', accent: '#087b8c', ink: '#18222d' },
  },
  {
    id: 'material', label: 'theme.material', scheme: 'light', metaColor: '#f7f9ff',
    preview: { background: '#f7f9ff', sidebar: '#eef3ff', surface: '#ffffff', accent: '#325ea8', ink: '#172033' },
  },
  {
    id: 'apple', label: 'theme.apple', scheme: 'light', metaColor: '#eef2f7',
    preview: { background: '#eef2f7', sidebar: '#e7ecf2', surface: '#ffffff', accent: '#006bd6', ink: '#15171a' },
  },
  {
    id: 'tesla', label: 'theme.tesla', scheme: 'light', metaColor: '#f4f4f4',
    preview: { background: '#f4f4f4', sidebar: '#ffffff', surface: '#ffffff', accent: '#3e6ae1', ink: '#171a20' },
  },
  {
    id: 'carbon', label: 'theme.carbon', scheme: 'dark', metaColor: '#161616',
    preview: { background: '#161616', sidebar: '#0f0f0f', surface: '#262626', accent: '#78a9ff', ink: '#f4f4f4' },
  },
  {
    id: 'fluent', label: 'theme.fluent', scheme: 'light', metaColor: '#eef5fc',
    preview: { background: '#eef5fc', sidebar: '#e2eef9', surface: '#fbfdff', accent: '#0f6cbd', ink: '#15243a' },
  },
  {
    id: 'primer', label: 'theme.primer', scheme: 'light', metaColor: '#f6f8fa',
    preview: { background: '#f6f8fa', sidebar: '#ffffff', surface: '#ffffff', accent: '#0969da', ink: '#1f2328' },
  },
  {
    id: 'polaris', label: 'theme.polaris', scheme: 'light', metaColor: '#f4f6f4',
    preview: { background: '#f4f6f4', sidebar: '#f8faf8', surface: '#ffffff', accent: '#087f5b', ink: '#202623' },
  },
  {
    id: 'bauhaus', label: 'theme.bauhaus', scheme: 'light', metaColor: '#f4efdf',
    preview: { background: '#f4efdf', sidebar: '#f4efdf', surface: '#fffaf0', accent: '#e13719', ink: '#111111' },
  },
  {
    id: 'editorial', label: 'theme.editorial', scheme: 'light', metaColor: '#f4f0e7',
    preview: { background: '#f4f0e7', sidebar: '#eee8dc', surface: '#faf7f0', accent: '#b83225', ink: '#211d19' },
  },
  {
    id: 'solarized', label: 'theme.solarized', scheme: 'dark', metaColor: '#002b36',
    preview: { background: '#002b36', sidebar: '#073642', surface: '#073642', accent: '#2aa198', ink: '#f1f0df' },
  },
  {
    id: 'terminal', label: 'theme.terminal', scheme: 'dark', metaColor: '#071108',
    preview: { background: '#071108', sidebar: '#030804', surface: '#0b160c', accent: '#9be564', ink: '#d4f7b5' },
  },
  {
    id: 'vaporwave', label: 'theme.vaporwave', scheme: 'dark', metaColor: '#171331',
    preview: { background: '#171331', sidebar: '#111027', surface: '#242048', accent: '#ff71ce', ink: '#f8f5ff' },
  },
  {
    id: 'cypherpunk', label: 'theme.cypherpunk', scheme: 'dark', metaColor: '#070907',
    preview: { background: '#070907', sidebar: '#030403', surface: '#111410', accent: '#d7ff3f', ink: '#f4f7ee' },
  },
  {
    id: 'nordic', label: 'theme.nordic', scheme: 'light', metaColor: '#eaf0f3',
    preview: { background: '#eaf0f3', sidebar: '#dbe7ed', surface: '#f9fbfc', accent: '#245b78', ink: '#1c2f3a' },
  },
  {
    id: 'clay', label: 'theme.clay', scheme: 'light', metaColor: '#e8f0fb',
    preview: { background: '#e8f0fb', sidebar: '#dce8f7', surface: '#f3f7fd', accent: '#326fd1', ink: '#24324a' },
  },
] as const satisfies readonly ThemeDefinition[]

export type Theme = (typeof themeOptions)[number]['id']
export type ThemeOption = (typeof themeOptions)[number]

export const themeIds = themeOptions.map(({ id }) => id)
export const THEME_STORAGE_KEY = 'skillops.theme.v2'
export const LEGACY_THEME_STORAGE_KEY = 'skillops.theme.v1'
export const SYSTEM_LIGHT_THEME: Theme = 'devtools'
export const SYSTEM_DARK_THEME: Theme = 'synapse'
export const legacyThemeMap = {
  light: SYSTEM_LIGHT_THEME,
  dark: SYSTEM_DARK_THEME,
} as const

export const themeBootstrapConfig = {
  storageKey: THEME_STORAGE_KEY,
  legacyStorageKey: LEGACY_THEME_STORAGE_KEY,
  legacyThemeMap,
  systemThemes: {
    light: SYSTEM_LIGHT_THEME,
    dark: SYSTEM_DARK_THEME,
  },
  themes: themeOptions.map(({ id, scheme, metaColor }) => ({ id, scheme, metaColor })),
} as const

export function getThemeOption(theme: Theme) {
  return themeOptions.find((option) => option.id === theme) ?? themeOptions[0]
}
