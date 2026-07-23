/**
 * Theme mode store: light, dark, or system.
 */
import { defineStore } from 'pinia'
import { ref, watch, computed, type Ref } from 'vue'

type ThemeMode = 'light' | 'dark' | 'system'

export const useThemeStore = defineStore('theme', () => {
  const mode: Ref<ThemeMode> = ref((localStorage.getItem('theme') as ThemeMode) || 'system')

  const resolvedTheme = computed(() => {
    if (mode.value === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return mode.value
  })

  const isDark = computed(() => resolvedTheme.value === 'dark')

  function applyTheme() {
    const theme = resolvedTheme.value
    document.documentElement.classList.remove('light', 'dark')
    document.documentElement.classList.add(theme)

    const metaThemeColor = document.querySelector('meta[name="theme-color"]')
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#ffffff')
    }
  }

  function setTheme(newMode: ThemeMode) {
    mode.value = newMode
    localStorage.setItem('theme', newMode)
    applyTheme()
  }

  function toggleTheme() {
    const modes: ThemeMode[] = ['dark', 'light', 'system']
    const currentIndex = modes.indexOf(mode.value)
    setTheme(modes[(currentIndex + 1) % modes.length])
  }

  function setupSystemThemeListener() {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    mediaQuery.addEventListener('change', () => {
      if (mode.value === 'system') applyTheme()
    })
  }

  function init() {
    applyTheme()
    setupSystemThemeListener()
  }

  watch(mode, applyTheme)

  return { mode, resolvedTheme, isDark, toggleTheme, setTheme, applyTheme, init }
})
