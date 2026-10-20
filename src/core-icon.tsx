const paths: Record<string, string> = {
  多公司店铺: 'M4 20V6h6v14M10 20V10h6v10M16 20V4h4v16M3 20h18',
  财务月结: 'M5 6h14v12H5zM8 10h8M8 14h5',
  订单与退货: 'M4 7h16l-1.5 11h-13zM8 7V5a4 4 0 0 1 8 0v2',
  广告报表: 'M4 18V10M10 18V6M16 18v-5M20 18H3',
  成员分工: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM4 19c.4-2.4 2.4-4 5-4s4.6 1.6 5 4M14 15c1.8 0 3.4 1 4 3',
  库存对照: 'M4 8l8-4 8 4-8 4-8-4zM4 8v8l8 4 8-4V8M12 12v8',
  授权边界: 'M12 3l7 3v6c0 4.2-2.8 7.2-7 8-4.2-.8-7-3.8-7-8V6l7-3z',
  网页查看: 'M4 5h16v11H4zM8 20h8M12 16v4',
  'FBA 库存': 'M4 8l8-4 8 4-8 4-8-4zM4 8v8l8 4 8-4V8',
  商品刊登: 'M6 4h8l4 4v12H6zM14 4v4h4M9 12h6M9 16h4',
  'FBA 入库': 'M4 8h16v10H4zM8 8V6h8v2M9 13h6',
  订单: 'M4 7h16l-1.5 11h-13zM8 7V5a4 4 0 0 1 8 0v2',
  退货月结: 'M5 6h14v12H5zM8 10h8M8 14h5',
  财务: 'M5 6h14v12H5zM8 10h8M8 14h5',
  团队权限: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM4 19c.4-2.4 2.4-4 5-4s4.6 1.6 5 4M14 15c1.8 0 3.4 1 4 3',
  三档价格: 'M5 7h14v4H5zM5 13h14v4H5zM8 9h.01M8 15h.01',
  客户案例: 'M6 8h12v10H6zM9 8V6h6v2M8 12h8',
  公司和地址: 'M12 21s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10zM12 11.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  最新动态: 'M5 5h10l4 4v10H5zM15 5v4h4M8 13h8M8 16h5',
}

export function CoreIcon({ name }: { name: string }) {
  return <i aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name] ?? paths['网页查看']} /></svg></i>
}
