// GSAP 统一入口：当前仅用于克制的入场揭示动画。
import gsap from 'gsap'

/** 系统是否开启"减少动态"。开启时所有入场/滚动动画降级为静态（内容默认可见）。 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export { gsap }
