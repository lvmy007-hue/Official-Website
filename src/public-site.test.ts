import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { company } from './site-company'
import { homeHero, pageMeta, publicCopyText, publicDocumentPaths, websitePageFromPath } from './public-site-content'
import { pricingFaqs } from './public-product-content'

describe('public site copy', () => {
  it('resolves the published routes and leaves unknown paths empty', () => {
    expect(websitePageFromPath('/')).toBe('home')
    expect(websitePageFromPath('/site')).toBe('home')
    expect(websitePageFromPath('/privacy')).toBe('privacy')
    expect(websitePageFromPath('/product/stores')).toBe('product-stores')
    expect(websitePageFromPath('/product/returns')).toBe('product-returns')
    expect(websitePageFromPath('/product/finance')).toBe('product-finance')
    expect(websitePageFromPath('/product/advertising')).toBe('product-advertising')
    expect(websitePageFromPath('/solutions/advertising')).toBe('solutions-advertising')
    expect(websitePageFromPath('/pricing')).toBe('pricing')
    expect(websitePageFromPath('/help')).toBeNull()
    expect(websitePageFromPath('/en')).toBeNull()
  })

  it('keeps the homepage claim bounded to implemented behavior', () => {
    const text = publicCopyText()
    expect(homeHero.title).toContain('多店铺')
    expect(text).toContain(company.legalName)
    expect(text).toContain(company.email)
    expect(text).toContain('Inventory and Order Tracking')
    expect(text).toContain('Finance and Accounting')
    expect(text).toContain('单公司起步')
    expect(text).toContain('演示数据')
    for (const phrase of ['官方合作伙伴', '已认证', 'SOC 2', '银行级', '免费注册', '待填写', 'Northstar', '已接入', '功能建设中', '草案', '尚未配置']) {
      expect(text).not.toContain(phrase)
    }
    expect(JSON.stringify(pricingFaqs)).not.toMatch(/[¥$]\s*\d/)
    expect(pageMeta.home.canonical).toBe('https://dzanx.com/')
  })

  it('publishes the new routes in the sitemap and dev server allow list', () => {
    const sitemap = readFileSync('public/sitemap.xml', 'utf8')
    const nginx = readFileSync('infrastructure/aliyun/nginx.conf', 'utf8')
    const viteConfig = readFileSync('vite.config.ts', 'utf8')
    for (const path of ['/product/stores', '/product/orders', '/product/returns', '/product/finance', '/product/advertising', '/product/permissions', '/product/inventory', '/product/listings', '/product/inbound', '/solutions/advertising', '/pricing', '/news', '/resources']) {
      expect(publicDocumentPaths().has(path)).toBe(true)
      expect(sitemap).toContain(`https://dzanx.com${path}`)
      expect(viteConfig).toContain(`'${path}'`)
      expect(nginx).toContain(path.slice(1))
    }
  })
})
