import { Header } from './Header'
import { Hero } from './Hero'
import { TrustBar } from './TrustBar'
import { Capabilities } from './Capabilities'
import { ValueProps } from './ValueProps'
import { Scenarios } from './Scenarios'
import { Solutions } from './Solutions'
import { Modules } from './Modules'
import { Security } from './Security'
import { Process } from './Process'
import { Footer } from './Footer'
import { LangContext, type Lang } from './i18n'

export function HomePage({ lang = 'zh' }: { lang?: Lang }) {
  return (
    <LangContext.Provider value={lang}>
      <div className="nv min-h-screen bg-white font-sans text-ink antialiased" lang={lang}>
        <a className="sr-only" href="#main">{lang === 'en' ? 'Skip to content' : '跳到主要内容'}</a>
        <Header />
        <main id="main">
          <Hero />
          <TrustBar />
          <ValueProps />
          <Capabilities />
          <Scenarios />
          <Solutions />
          <Modules />
          <Security />
          <Process />
        </main>
        <Footer />
      </div>
    </LangContext.Provider>
  )
}
