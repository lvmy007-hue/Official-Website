export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="NOVA ERP">
    <defs>
      <linearGradient id="nova-mark-fill" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#4c8dff" />
        <stop offset="1" stopColor="#2349d8" />
      </linearGradient>
    </defs>
    <rect width="48" height="48" rx="12" fill="url(#nova-mark-fill)" />
    <path d="M12 35V13h4.8l11.2 14.6V13H32v22h-4.8L16 20.4V35z" fill="#fff" />
    <path d="M38 6.5l1.2 3.3 3.3 1.2-3.3 1.2-1.2 3.3-1.2-3.3-3.3-1.2 3.3-1.2z" fill="#fff" />
  </svg>
}

export function BrandLockup({ tagline = 'DZANX' }: { tagline?: string }) {
  return <span className="nova-lockup"><BrandMark /><span><b>NOVA ERP</b><small>{tagline}</small></span></span>
}
