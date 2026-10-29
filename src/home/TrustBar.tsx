import { MapPin, Eye, Clock, Users } from 'lucide-react'
import { useT } from './i18n'

export function TrustBar() {
  const t = useT()
  const FACTS = [
    { icon: MapPin, k: t('数据存放中国境内', 'Data hosted in China'), d: t('经营数据存放于境内云数据库', 'Business data on a mainland-China cloud database') },
    { icon: Eye, k: t('广告只读', 'Advertising read-only'), d: t('仅查看与对账，不改出价、不代投放', 'View and reconcile only, no bid changes') },
    { icon: Clock, k: t('买家信息 ≤ 30 天', 'Buyer data ≤ 30 days'), d: t('发货后按政策定期删除', 'Deleted on schedule after shipment') },
    { icon: Users, k: t('按法律主体隔离', 'Isolated by legal entity'), d: t('多公司分权，账套互不混淆', 'Scoped per company, books kept separate') },
  ]
  return (
    <section className="border-b border-line bg-canvas-soft">
      <div className="nv-container-wide grid grid-cols-2 gap-x-8 gap-y-7 py-8 lg:grid-cols-4 lg:divide-x lg:divide-line">
        {FACTS.map((f, i) => (
          <div key={f.k} className={`flex items-start gap-3 ${i > 0 ? 'lg:pl-8' : ''}`}>
            <f.icon size={20} strokeWidth={1.7} className="mt-0.5 shrink-0 text-brand-600" />
            <div>
              <b className="block text-[14.5px] font-bold text-ink">{f.k}</b>
              <p className="mt-0.5 text-[12.5px] leading-5 text-ink-mute">{f.d}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
