import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'

import en from './locales/en.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import pt from './locales/pt.json'
import zh from './locales/zh.json'

const catalogs = { es, fr, ja, ko, pt, zh }
const resetKeys = [
  'oneFiveHourCard',
  'fiveHourCards',
  'oneWeekCard',
  'weekCards',
  'weekCardTitle',
  'weekCardBody',
  'resetCreditTitle',
  'resetCreditBody',
  'useWeekCard'
] as const

function resetKey(suffix: string): string {
  return `auto.components.status.bar.StatusBar.zcode.${suffix}`
}

describe('ZCode reset-credit locale catalogs', () => {
  it.each(Object.entries(catalogs))(
    '%s translates every reset-credit message',
    async (locale, catalog) => {
      const instance = createInstance()
      await instance.init({
        lng: locale,
        resources: { en: { translation: en }, [locale]: { translation: catalog } },
        interpolation: { escapeValue: false }
      })

      for (const suffix of resetKeys) {
        const key = resetKey(suffix)
        const translated = instance.getResource(locale, 'translation', key)
        expect(translated).toEqual(expect.any(String))
        expect(translated).not.toBe(instance.getResource('en', 'translation', key))
      }
      expect(instance.t(resetKey('fiveHourCards'), { value0: 3 })).toContain('3')
      expect(instance.t(resetKey('weekCards'), { value0: 2 })).toContain('2')
    }
  )
})
