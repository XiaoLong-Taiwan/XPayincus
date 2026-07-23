import { onMounted, onBeforeUnmount, type Ref } from 'vue'
import { gsap, prefersReducedMotion } from '@/lib/gsap'

/**
 * 滚动揭示：容器内所有 [data-reveal] 元素进入视口时用 GSAP 淡入上移。
 * 采用 IntersectionObserver（不依赖 ScrollTrigger 位置计算，钉住区也不受影响）。
 * 渐进增强：减少动态或无 IO 时内容保持可见，绝不因动画失败而空白。
 */
export function useReveal(
  root: Ref<HTMLElement | null>,
  options: { y?: number; duration?: number; stagger?: number } = {}
): void {
  let io: IntersectionObserver | null = null

  onMounted(() => {
    const container = root.value
    if (!container) return
    const els = Array.from(container.querySelectorAll<HTMLElement>('[data-reveal]'))
    if (!els.length) return

    if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
      gsap.set(els, { autoAlpha: 1, y: 0 })
      return
    }

    gsap.set(els, { autoAlpha: 0, y: options.y ?? 16 })
    io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            gsap.to(entry.target, {
              autoAlpha: 1,
              y: 0,
              duration: options.duration ?? 0.7,
              ease: 'power3.out'
            })
            io?.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.12, rootMargin: '0px 0px -5% 0px' }
    )
    els.forEach((el) => io!.observe(el))
  })

  onBeforeUnmount(() => {
    io?.disconnect()
    io = null
  })
}
