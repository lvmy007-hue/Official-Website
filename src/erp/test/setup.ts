import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'

// 组件测试环境（jsdom）补齐 Ant Design 与图表依赖的浏览器能力；纯逻辑测试（node 环境）不受影响。
if (typeof window !== 'undefined') {
  const { cleanup, configure } = await import('@testing-library/react')
  // 整套测试并行时机器繁忙，默认 1 秒的等待会让个别页面用例偶发超时；等待上限放宽到 5 秒（用例本身的超时另行配置）
  configure({ asyncUtilTimeout: 5000 })
  afterEach(() => {
    cleanup()
    window.history.replaceState({}, '', '/')
  })

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { writable: true, value: ResizeObserverStub })
  window.scrollTo = () => undefined
  Element.prototype.scrollIntoView = () => undefined
}
