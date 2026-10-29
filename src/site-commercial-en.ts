import { company } from './site-company'

export const enPress = [
  { date: '2026-10', tag: 'Operations', title: 'Multi-company, multi-store workspace', text: 'Manage stores and marketplaces for multiple companies by legal entity in one workspace, with each company’s books clearly owned and never mixed.' },
  { date: '2026-10', tag: 'Finance', title: 'Multi-currency financial reconciliation', text: 'Revenue, refunds and fees are reconciled within the same currency, refunds map back to the original order month, and month-end close is more accurate.' },
  { date: '2026-10', tag: 'Advertising', title: 'Read-only advertising analytics', text: 'Ad spend, clicks and ad sales are viewed centrally; reports are read-only — no bid changes, no managed operations.' },
  { date: '2026-10', tag: 'Security', title: 'Data security and tiered permissions', text: `Operations, finance and advertising view data scoped by entity; buyer personal information is deleted on schedule within about ${company.piiRetentionDays} days after fulfillment.` },
  { date: '2026-09', tag: 'Supply chain', title: 'Purchasing and supplier management', text: 'Maintain supplier profiles, create and track purchase orders, and manage stocking and arrivals alongside operating data.' },
  { date: '2026-09', tag: 'Supply chain', title: 'Warehouses and inventory ledger', text: 'Manage multiple warehouses and record inbound, outbound and transfer movements, so every stock change is traceable.' },
  { date: '2026-08', tag: 'Data', title: 'Report center launched', text: 'Generate order, inventory, finance and advertising report tasks on demand, and export results for review and archiving.' },
]

export const enGuides = [
  { title: 'How to get started', text: 'Once you confirm your company entities, store scale, required modules and member permissions, our team helps you connect and deploy.', href: '/contact' },
  { title: 'Which marketplaces and currencies are supported', text: 'Multiple marketplaces and currencies are supported, reconciled in account currency, with different currencies never added together.', href: '/product' },
  { title: 'How to view advertising data', text: 'Advertising accounts are connected separately; spend and ad sales are viewed read-only for analysis and reconciliation.', href: '/solutions/advertising' },
  { title: 'Data security and protection', text: 'Data is encrypted in transit and at rest, permissions are tiered by entity, and buyer information is deleted on schedule.', href: '/security' },
  { title: 'Company contact information', text: 'The operating entity is ' + company.legalNameEn + '; address and email follow the About page.', href: '/about' },
]
