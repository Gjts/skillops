import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { localeOptions, messages, type Locale, type MessageKey } from './messages'

const STORAGE_KEY = 'skillops.locale.v1'
const localeCodes = new Set<Locale>(localeOptions.map((option) => option.code))
const numberFormatters = new Map<string, Intl.NumberFormat>()
const dateFormatters = new Map<string, Intl.DateTimeFormat>()
const defaultDateOptions: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
const defaultTimeOptions: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
const defaultDateTimeOptions: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }

type MessageValues = Record<string, string | number>

function isLocale(value: string | null | undefined): value is Locale {
  return Boolean(value && localeCodes.has(value as Locale))
}

function translate(locale: Locale, key: MessageKey, values: MessageValues = {}) {
  return messages[key][locale].replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => {
    const value = values[name]
    return value === undefined ? placeholder : String(value)
  })
}

function numberFormatter(locale: string, options?: Intl.NumberFormatOptions) {
  const key = `${locale}:${JSON.stringify(options ?? {})}`
  const cached = numberFormatters.get(key)
  if (cached) return cached
  const formatter = new Intl.NumberFormat(locale, options)
  numberFormatters.set(key, formatter)
  return formatter
}

function dateFormatter(locale: string, options?: Intl.DateTimeFormatOptions) {
  const key = `${locale}:${JSON.stringify(options ?? {})}`
  const cached = dateFormatters.get(key)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat(locale, options)
  dateFormatters.set(key, formatter)
  return formatter
}

function formatDateValue(locale: string, value: string | number | Date, options?: Intl.DateTimeFormatOptions) {
  return dateFormatter(locale, options ?? defaultDateOptions).format(new Date(value))
}

function formatTimeValue(locale: string, value: string | number | Date, options?: Intl.DateTimeFormatOptions) {
  return dateFormatter(locale, options ?? defaultTimeOptions).format(new Date(value))
}

function formatDateTimeValue(locale: string, value: string | number | Date, options?: Intl.DateTimeFormatOptions) {
  return dateFormatter(locale, options ?? defaultDateTimeOptions).format(new Date(value))
}

function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'en'
  let stored: string | null = null
  try { stored = window.localStorage.getItem(STORAGE_KEY) } catch { /* Storage can be disabled by browser policy. */ }
  if (isLocale(stored)) return stored
  for (const candidate of navigator.languages ?? [navigator.language]) {
    const normalized = candidate.toLowerCase().split('-')[0]
    if (isLocale(normalized)) return normalized
  }
  return 'en'
}

export interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: MessageKey, values?: MessageValues) => string
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string
  formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string
  formatTime: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string
  formatDateTime: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string
  formatDuration: (milliseconds?: number) => string
}

function createFallbackContext(): I18nContextValue {
  const intl = 'en'
  const number = numberFormatter(intl)
  return {
    locale: 'en',
    setLocale: () => undefined,
    t: (key, values) => translate('en', key, values),
    formatNumber: (value, options) => numberFormatter(intl, options).format(value),
    formatDate: (value, options) => formatDateValue(intl, value, options),
    formatTime: (value, options) => formatTimeValue(intl, value, options),
    formatDateTime: (value, options) => formatDateTimeValue(intl, value, options),
    formatDuration: (milliseconds) => {
      if (milliseconds === undefined) return '—'
      const seconds = Math.round(milliseconds / 1000)
      if (seconds >= 60) return `${number.format(Math.floor(seconds / 60))}m ${number.format(seconds % 60)}s`
      return `${number.format(seconds)}s`
    },
  }
}

const I18nContext = createContext<I18nContextValue>(createFallbackContext())

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale)
  const config = localeOptions.find((option) => option.code === locale)!

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, locale) } catch { /* Keep the in-memory locale when storage is unavailable. */ }
    document.documentElement.lang = config.intl
    document.documentElement.dir = 'ltr'
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', translate(locale, 'meta.description'))
  }, [config.intl, locale])

  const t = useCallback((key: MessageKey, values?: MessageValues) => translate(locale, key, values), [locale])
  const formatNumber = useCallback((value: number, options?: Intl.NumberFormatOptions) => numberFormatter(config.intl, options).format(value), [config.intl])
  const formatDate = useCallback((value: string | number | Date, options?: Intl.DateTimeFormatOptions) => formatDateValue(config.intl, value, options), [config.intl])
  const formatTime = useCallback((value: string | number | Date, options?: Intl.DateTimeFormatOptions) => formatTimeValue(config.intl, value, options), [config.intl])
  const formatDateTime = useCallback((value: string | number | Date, options?: Intl.DateTimeFormatOptions) => formatDateTimeValue(config.intl, value, options), [config.intl])
  const formatDuration = useCallback((milliseconds?: number) => {
    if (milliseconds === undefined) return '—'
    const seconds = Math.round(milliseconds / 1000)
    if (seconds >= 60) {
      return `${t('units.minutes', { value: formatNumber(Math.floor(seconds / 60)) })} ${t('units.seconds', { value: formatNumber(seconds % 60) })}`
    }
    return t('units.seconds', { value: formatNumber(seconds) })
  }, [formatNumber, t])

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    t,
    formatNumber,
    formatDate,
    formatTime,
    formatDateTime,
    formatDuration,
  }), [formatDate, formatDateTime, formatDuration, formatNumber, formatTime, locale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}
