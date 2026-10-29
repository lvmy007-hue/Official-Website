import { company } from './site-company'
import type { PanelKey } from './lx-panels'

const legal = `${company.legalNameEn} (${company.legalName})`

export const enNav = [
  { href: '/en', label: 'Home' },
  { href: '/en/product', label: 'Product' },
  { href: '/en/pricing', label: 'Pricing' },
  { href: '/en/about', label: 'About' },
  { href: '/en/contact', label: 'Contact' },
]

export const enHero = {
  kicker: legal,
  lineOne: 'When several companies sell together',
  lineTwo: 'see every store, company by company',
  lede: `NOVA ERP consolidates orders, inventory, inbound, finance and advertising reports for multi-entity Amazon sellers into a single workspace — books reconciled per legal entity, advertising data read-only, buyer information deleted on a compliance schedule.`,
  ticks: ['Multi-entity, multi-marketplace in one place', 'Per-currency reconciliation', 'Read-only advertising analytics'],
}

export const enCoreCards = [
  { title: 'Inventory and inbound', text: 'Sellable, reserved, inbound and unfulfillable units under each authorized seller account.', href: '/en/product#supply', icon: 'FBA 库存' },
  { title: 'Finance', text: 'Revenue, refunds and fees listed per currency. Refunds are traced back to the order month.', href: '/en/product#finance', icon: '财务' },
  { title: 'Cross-month returns', text: 'A refund posted this month is matched to its original order instead of this month\'s sales.', href: '/en/product#finance', icon: '退货月结' },
  { title: 'Advertising reports', text: 'Spend, clicks and ad sales after the ads account is authorized. Read-only.', href: '/en/product#ads', icon: '广告' },
  { title: 'Orders', text: 'Purchase date, status and currency stay with the store. Buyer data is deleted 30 days after shipment.', href: '/en/product#supply', icon: '订单' },
  { title: 'Listings', text: 'ASIN, SKU and listing status are read for matching. Listings are not edited.', href: '/en/product#supply', icon: '商品刊登' },
  { title: 'Member permissions', text: 'Finance, operations and ads staff see only the companies assigned to them.', href: '/en/product#operations', icon: '团队权限' },
  { title: 'FBA inbound', text: 'Plans require seller authorization first. Shipment IDs and received units come from sync results.', href: '/en/product#supply', icon: 'FBA 入库' },
]

export const enChapters: Array<{ title: string; lede: string; href: string; cta: string; points: Array<{ title: string; text: string; panel: PanelKey }> }> = [
  {
    title: 'Inventory, inbound and orders',
    lede: 'Inventory, inbound plans, listings and orders sit under the seller account of the same company. A company that has not authorized shows no numbers.',
    href: '/en/product#supply',
    cta: 'See inventory details',
    points: [
      { title: 'Inventory in one place', text: 'Sellable, reserved, inbound and unfulfillable units by marketplace and SKU. Low stock is flagged.', panel: 'inventory' },
      { title: 'Inbound plans', text: 'Seller authorization comes first. Shipment IDs and received units come from sync results.', panel: 'inbound' },
      { title: 'Listing matching', text: 'ASIN, SKU and listing status are used to match orders and inventory. Listings are not edited.', panel: 'listings' },
      { title: 'Orders by store', text: 'Purchase date, status and currency stay with the store. Orders across companies can be filtered by permission.', panel: 'orders' },
    ],
  },
  {
    title: 'Finance you can reconcile',
    lede: 'Revenue, refunds and fees are listed in the same currency. A refund posted this month can be traced back to its original order month.',
    href: '/en/product#finance',
    cta: 'See finance details',
    points: [
      { title: 'Net within one currency', text: 'US dollars and Japanese yen are never added into one total. Monthly reports are produced per company and currency.', panel: 'finance' },
      { title: 'Refunds back to the order month', text: 'Return records keep the return date and original order ID, so old orders do not reduce new sales.', panel: 'returns' },
      { title: 'Fees keep their posting date', text: 'Fee events keep amount, currency and posted date, with the settlement ID when available.', panel: 'fees' },
    ],
  },
  {
    title: 'Stores separated by company',
    lede: 'Each company registers its seller accounts and marketplaces first, then members view them by permission. Signing in does not open every company.',
    href: '/en/product#operations',
    cta: 'See store details',
    points: [
      { title: 'Seller accounts under a legal entity', text: 'Company, seller account and marketplace are stored in layers. An account never floats outside its legal entity.', panel: 'stores' },
      { title: 'Authorization status is visible', text: 'Each connection records its authorization state and last successful sync. Pending connections stay pending.', panel: 'connections' },
      { title: 'Member scope follows the company', text: 'Operations, finance and ads staff use different permissions. New members are granted access by role.', panel: 'permissions' },
    ],
  },
  {
    title: 'Advertising reports, read-only',
    lede: 'The advertising account and the seller account are authorized separately. Seller authorization does not bring in spend, clicks or ad sales.',
    href: '/en/product#ads',
    cta: 'See advertising details',
    points: [
      { title: 'An ads account comes first', text: 'Teams that have not authorized an ads account see no spend or ad sales.', panel: 'adsAccount' },
      { title: 'Read in the account currency', text: 'Spend, clicks, CTR, CPC, ad sales, ACOS and ROAS stay in the account\'s own currency.', panel: 'ads' },
      { title: 'Read-only, no managed campaigns', text: 'Reports can be compared. Bids and budgets are not changed and campaigns are not run for the customer.', panel: 'adsFlow' },
    ],
  },
]

export const enReasons = [
  { title: 'Covers the operating chain', lines: ['Stores, orders, returns and finance in one plan', 'Advertising reports are a separate module', 'Used in the browser; scope confirmed in writing'], num: '10', tip: 'operating topics on the site' },
  { title: 'Data separated by company', lines: ['Each company starts its own seller authorization', 'Ads accounts are authorized once more', `Buyer personal data deleted within ${company.piiRetentionDays} days after shipment`], num: `${company.piiRetentionDays} days`, tip: 'buyer data deletion window' },
  { title: 'A person follows up', lines: ['Entities, stores and modules confirmed after booking', 'Implementation and higher sync frequency quoted separately', 'Registered in Xuchang, delivered under a written plan'], num: '1', tip: 'service city' },
]

export const enProductGroups: Array<{ id: string; title: string; text: string; items: Array<{ href: string; title: string; sell: string; points: string[] }> }> = [
  {
    id: 'finance',
    title: 'Finance',
    text: 'Revenue, refunds and fees reconciled within each currency, with refunds traced to the order month.',
    items: [
      { href: '/product/finance', title: 'Finance', sell: 'Revenue, refunds and fees listed per currency so monthly reports can be checked directly.', points: ['Net amounts within one currency', 'USD and JPY never added together', 'Fees keep their posted date'] },
      { href: '/product/returns', title: 'Cross-month returns', sell: 'A refund issued this month is matched to the month the order was placed.', points: ['Refund linked to the original order', 'Old refunds do not reduce new sales', 'Return date kept with the record'] },
    ],
  },
  {
    id: 'supply',
    title: 'Supply chain',
    text: 'Inventory, inbound, listings and orders, organized by seller account.',
    items: [
      { href: '/product/inventory', title: 'FBA inventory', sell: 'Sellable, reserved, inbound and unfulfillable units under the company\'s own seller account.', points: ['Quantities by marketplace and SKU', 'Low stock flagged', 'Clear data ownership by company'] },
      { href: '/product/inbound', title: 'FBA inbound', sell: 'Inbound plans and shipments created and viewed under each seller account.', points: ['Plans and shipments tracked separately', 'Ship-from address captured as required', 'Shipment IDs and received units tracked'] },
      { href: '/product/listings', title: 'Listings', sell: 'ASIN, SKU and listing status matched to the same store for orders and inventory.', points: ['ASIN and SKU kept', 'FNSKU and fulfillment channel kept', 'Used for matching, not editing'] },
      { href: '/product/orders', title: 'Orders', sell: 'Each order keeps its company, marketplace and purchase date.', points: ['Purchase date and status by store', 'Amounts carry their currency', `Buyer data deleted within ${company.piiRetentionDays} days after shipment`] },
      { href: '/product/stores', title: 'Multiple stores', sell: 'Each company\'s stores are managed separately and never mixed with another company.', points: ['Seller accounts and marketplaces registered by company', 'Stores clearly organized by company', 'Members see only assigned companies'] },
    ],
  },
  {
    id: 'operations',
    title: 'Operations',
    text: 'Who can see which company is decided by membership and permission, not by signing in.',
    items: [
      { href: '/product/permissions', title: 'Member permissions', sell: 'Finance, operations and ads staff each see their own companies; owners see all.', points: ['Access assigned per company', 'Viewing and managing connections are separate permissions', 'New members granted access by role'] },
    ],
  },
  {
    id: 'ads',
    title: 'Advertising',
    text: 'Advertising spend and sales in one place. Reports are read-only.',
    items: [
      { href: '/product/advertising', title: 'Advertising reports', sell: 'Ad spend is reported on its own, so store data and ad numbers stay separate.', points: ['Ads data connected separately', 'Spend, clicks and ad sales', 'Reports only, no managed campaigns'] },
    ],
  },
]

export const enPlans = [
  { name: 'Single company', price: 'Written quote', unit: '', fit: '1 legal entity, 1 to 5 stores', points: ['Orders, returns and inventory', 'Listings and FBA inbound', 'Monthly finance and member permissions', 'Advertising reports not included'], featured: false },
  { name: 'Multiple companies', price: 'Written quote', unit: '', fit: 'Up to 3 legal entities, 6 to 20 stores', points: ['Everything in Single company', 'Books separated by legal entity', 'Read-only advertising reports', 'Each entity managed separately'], featured: true },
  { name: 'Beyond these limits', price: 'Written quote', unit: '', fit: 'More than 3 entities, or on-site implementation', points: ['Modules combined to the confirmed scope', 'Implementation agreed separately', 'No managed advertising', 'Written plan issued separately'], featured: false },
]

export const enCompare = [
  ['Orders, returns, inventory', 'Included', 'Included', 'Included'],
  ['Monthly finance', 'Included', 'Included', 'Included'],
  ['Member permissions', 'Included', 'Included', 'Included'],
  ['Advertising reports', 'Not included', 'Included', 'Included'],
  ['Separated by legal entity', '1', '3', 'Per plan'],
  ['Onboarding', 'Remote', 'With implementation', 'On-site'],
]

export const enPricingSteps = [
  ['01', 'Submit a request', 'Tell us the number of legal entities, stores and the reports you need.'],
  ['02', 'Confirm the scope', 'We confirm which companies are included and which modules are used.'],
  ['03', 'Written plan', 'Fees, term and support are set out in a written plan agreed by both sides.'],
]

export const enPricingFaqs = [
  { q: 'Can I pay on this website?', a: 'No. Service starts after a written plan is agreed, and payment follows that plan.' },
  { q: 'How do I start?', a: `Submit the contact form or email ${company.email}. There is no self-service sign-up.` },
  { q: 'Are advertising reports included?', a: 'Not in Single company. They are included in Multiple companies and above, and require a separate ads authorization.' },
  { q: 'Where is data stored and for how long?', a: `Business data is stored in mainland China. Buyer personal data is deleted within ${company.piiRetentionDays} days after shipment.` },
  { q: 'Do we need developers?', a: 'No. Reports are used in the browser. Authorization is completed by the seller in Seller Central.' },
  { q: 'Do you manage our campaigns?', a: 'No. NOVA ERP provides reporting software. It does not change bids or run campaigns.' },
]

export const enPrivacy = [
  { h: 'Who we are', p: `${legal} operates NOVA ERP and this website. Unified social credit code: ${company.creditCode}. Address: ${company.addressEn}. Privacy questions: ${company.email}.` },
  { h: 'Data we collect', p: 'The contact form collects name, company name, business email, inquiry type, message, and optionally phone and store count. After a seller authorizes NOVA ERP, we read orders, inventory, returns, fees and product listings. After an advertising account is authorized separately, we read advertising profiles and reports. Do not enter Amazon passwords or tokens in the form.' },
  { h: 'How we use data', p: 'Contact information is used to reply about demos and onboarding. Seller data is used to show orders, inventory, returns and finance for the authorized company. Advertising data is used for reports on the authorized account. We do not sell any of this data.' },
  { h: 'Legal basis', p: 'Seller data is processed on the basis of the authorization given by that legal entity. Advertising data is processed on the basis of a separate authorization by the advertising account holder. Companies or ads accounts that have not authorized are not processed.' },
  { h: 'Where data is stored', p: `Business data is stored in ${company.storageRegion === '中国境内' ? 'mainland China' : company.storageRegion}. Access uses HTTPS. Refresh tokens are encrypted on the server with AES-256-GCM and are never returned to the browser.` },
  { h: 'Processors', p: 'We use a cloud database for business and contact records and a task queue to run data syncs. Cloud providers process data only on our instructions.' },
  { h: 'Sharing', p: `We do not sell seller data, advertising data or contact information. Apart from the database and queue providers that process data on our instructions, we do not provide this data to other companies. If law or a competent authority requires disclosure, we provide only what is required. Requests to access, correct or delete contact information can be sent to ${company.email}.` },
  { h: 'Access control and protection', p: 'Members must belong to the tenant and hold the matching permission to read orders, finance or advertising data. Data of different legal entities is separated by tenant.' },
  { h: 'Retention and deletion', p: `Buyer name, address, phone and email in orders are deleted within ${company.piiRetentionDays} days after the order ships, with no offline copy. When authorization is revoked, reading stops and stored buyer personal data is deleted within the same period. Contact records are kept for 24 months after we reply.` },
  { h: 'Your rights', p: `Send access, correction and deletion requests to ${company.email}. We reply within 15 working days.` },
  { h: 'Changes and transfers', p: 'When this policy changes, the version date is updated. Seller data is transferred outside mainland China only within the scope of authorization and the law, over encrypted connections.' },
]

export const enTerms = [
  { h: 'Operator and scope', p: `${legal} provides NOVA ERP: multi-store orders, inventory, returns and finance reporting, and advertising reports after the ads account is authorized. Managed advertising services are not provided.` },
  { h: 'Accounts and authorization', p: 'Workspace accounts are set up by the customer\'s administrator. Before Amazon data is connected, the relevant legal entity completes authorization itself. Users confirm they are entitled to authorize on behalf of that company.' },
  { h: 'User responsibilities', p: 'Do not give this website another company\'s seller account, password or token. Inquiries should be limited to business scope and contact details.' },
  { h: 'Fees and refunds', p: 'The pricing page explains what each tier includes. Fees are quoted in a written plan; no payment is taken on this website. Invoices and refunds follow the written plan.' },
  { h: 'Third-party platforms', p: 'Whether order, settlement and advertising data can be read depends on Amazon API eligibility, the scope of authorization and the limits of the APIs. If the platform changes an API, related reports may become unavailable.' },
  { h: 'Intellectual property', p: 'Website copy and interfaces describe NOVA ERP. Amazon and related names belong to their owners; their use here does not imply endorsement.' },
  { h: 'Suspension and termination', p: 'Access may be suspended where APIs are misused, the authorizing entity cannot be confirmed, or the contract ends. Termination terms follow the contract.' },
  { h: 'Governing law and contact', p: `These terms are governed by the laws of the People's Republic of China. Disputes are subject to the Weidu District People's Court of Xuchang. Contact: ${company.email}.` },
]

export const enSecurity = [
  { h: 'Transport', p: 'dzanx.com and the workspace API are served over HTTPS.' },
  { h: 'Credentials', p: 'Amazon refresh tokens are encrypted with AES-256-GCM before storage. If the encryption key is missing, the server refuses to store tokens rather than keeping them in plain text. Tokens are never shown in the interface.' },
  { h: 'Access control', p: 'Members must belong to the target tenant. Orders, refunds, finance, advertising, exports, members and connection management each use a separate permission.' },
  { h: 'Tenant isolation', p: 'Legal entity, connection, order and report queries all carry the tenant condition. Without membership the API refuses access.' },
  { h: 'Logs and audit', p: 'Sign-ins, authorizations and data reads record the actor, action, object and result for security review.' },
  { h: 'Sessions', p: 'Refresh credentials are stored only as hashes. Access tokens renew about every 15 minutes. After 15 minutes without activity the session ends. After 10 failed sign-ins the account is locked for 30 minutes.' },
  { h: 'Deletion', p: `Buyer personal data is deleted from the business database within ${company.piiRetentionDays} days after shipment and is no longer queried by the workspace.` },
  { h: 'Reporting a vulnerability', p: `Send security issues to ${company.email}. Do not include tokens or customer orders.` },
]

export const enMeta = {
  'en-home': { title: 'NOVA ERP | Multi-company, multi-store reporting for Amazon sellers', description: `${company.legalNameEn} operates NOVA ERP for orders, inventory, finance and read-only advertising reports across multiple companies and stores.`, path: '/en' },
  'en-product': { title: 'Product | NOVA ERP', description: 'Finance, supply chain, operations and advertising modules, and the Amazon data each one reads.', path: '/en/product' },
  'en-product-stores': { title: 'Multi-store & multi-entity | NOVA ERP', description: 'Manage stores by legal entity, so each company’s data is clearly owned and never mixed.', path: '/en/product/stores' },
  'en-product-orders': { title: 'Order management | NOVA ERP', description: 'Orders grouped by store, keeping purchase time, status, currency and source update time.', path: '/en/product/orders' },
  'en-product-returns': { title: 'Cross-month returns | NOVA ERP', description: 'Refunds map back to the original order month, so old-order refunds aren’t counted in this month’s sales.', path: '/en/product/returns' },
  'en-product-finance': { title: 'Financial reconciliation | NOVA ERP', description: 'Revenue, refunds and fees arranged per currency; different currencies are never added together.', path: '/en/product/finance' },
  'en-product-advertising': { title: 'Advertising reports | NOVA ERP', description: 'After connecting advertising accounts separately, spend, clicks and ad sales are viewed centrally, read-only.', path: '/en/product/advertising' },
  'en-product-permissions': { title: 'Member permissions | NOVA ERP', description: 'Who can see which company is decided by permissions; logging in does not mean seeing everything.', path: '/en/product/permissions' },
  'en-product-inventory': { title: 'FBA inventory | NOVA ERP', description: 'Available, reserved, inbound and unsellable quantities viewed centrally by seller account and marketplace.', path: '/en/product/inventory' },
  'en-product-listings': { title: 'Product listings | NOVA ERP', description: 'ASIN, SKU, FNSKU and listing status used to align stores and products.', path: '/en/product/listings' },
  'en-product-inbound': { title: 'FBA inbound | NOVA ERP', description: 'Inbound plans, shipments and received quantities managed centrally by seller account.', path: '/en/product/inbound' },
  'en-solutions': { title: 'Solutions | NOVA ERP', description: 'Capabilities combined around how you operate — multi-company, multi-marketplace and standalone advertising analytics.', path: '/en/solutions' },
  'en-solutions-advertising': { title: 'Advertising analytics · read-only | NOVA ERP', description: 'View ad spend and sales centrally and read-only, broken down by campaign type for analysis and reconciliation.', path: '/en/solutions/advertising' },
  'en-pricing': { title: 'Pricing | NOVA ERP', description: 'Written quotes for Single company, Multiple companies and larger scopes. Service follows a written plan; no payment on this website.', path: '/en/pricing' },
  'en-about': { title: 'About | NOVA ERP', description: `${company.legalNameEn} operates NOVA ERP for cross-border sellers, bringing multi-entity operations, supply chain, finance and advertising into one workspace.`, path: '/en/about' },
  'en-news': { title: 'Updates | NOVA ERP', description: 'A record of NOVA ERP feature updates and milestones. We don’t publish customer cases — only real product progress.', path: '/en/news' },
  'en-resources': { title: 'Resources | NOVA ERP', description: 'Guides, FAQs and support to help you get to know NOVA ERP and get started quickly.', path: '/en/resources' },
  'en-contact': { title: 'Contact | NOVA ERP', description: 'Book a demo or ask about onboarding. We reply by email on working days.', path: '/en/contact' },
  'en-privacy': { title: 'Privacy Policy | NOVA ERP', description: 'How seller data, advertising data and contact information are collected, used, stored, shared, protected and deleted.', path: '/en/privacy' },
  'en-terms': { title: 'Terms of Service | NOVA ERP', description: 'Service scope, authorization, fees and governing law for NOVA ERP.', path: '/en/terms' },
  'en-security': { title: 'Security | NOVA ERP', description: 'Transport encryption, credential encryption, permissions, tenant isolation, sessions and deletion.', path: '/en/security' },
} as const

export type EnglishPage = keyof typeof enMeta

export const enLegal = legal
