export type Order = { id: string; store: string; marketplace: string; amount: string; currency: string; status: string; fulfillment: string; purchasedAt: string; items: number }
export const stores = [
  { id: 'store-us', name: 'Northstar US', marketplace: 'US', sellerId: 'A3NOVAUS', health: '健康', lastSync: '2 分钟前', sales: '$246,820.40' },
  { id: 'store-uk', name: 'Northstar UK', marketplace: 'UK', sellerId: 'A1NOVAUK', health: '健康', lastSync: '7 分钟前', sales: '£98,410.20' },
  { id: 'store-de', name: 'Northstar DE', marketplace: 'DE', sellerId: 'A1NOVADE', health: '待处理', lastSync: '31 分钟前', sales: '€76,901.80' },
  { id: 'store-ca', name: 'Oak & Pine CA', marketplace: 'CA', sellerId: 'A2NOVACA', health: '健康', lastSync: '12 分钟前', sales: 'CA$64,788.00' },
]
export const orders: Order[] = [
  { id: '114-6382941-9021847', store: 'Northstar US', marketplace: 'US', amount: '128.00', currency: 'USD', status: '待发货', fulfillment: 'FBA', purchasedAt: '2026-10-17 10:42', items: 2 },
  { id: '114-1938204-4467712', store: 'Northstar UK', marketplace: 'UK', amount: '89.90', currency: 'GBP', status: '已发货', fulfillment: 'FBA', purchasedAt: '2026-10-17 10:18', items: 1 },
  { id: '114-8021193-0902456', store: 'Oak & Pine CA', marketplace: 'CA', amount: '32.50', currency: 'CAD', status: '已取消', fulfillment: 'FBM', purchasedAt: '2026-10-17 09:36', items: 1 },
  { id: '114-4720810-7635912', store: 'Northstar US', marketplace: 'US', amount: '249.00', currency: 'USD', status: '已发货', fulfillment: 'FBA', purchasedAt: '2026-10-17 09:12', items: 3 },
  { id: '114-9083214-1123458', store: 'Northstar DE', marketplace: 'DE', amount: '119.00', currency: 'EUR', status: '待发货', fulfillment: 'FBM', purchasedAt: '2026-10-17 08:57', items: 2 },
  { id: '114-7412938-5574201', store: 'Northstar US', marketplace: 'US', amount: '64.80', currency: 'USD', status: '已送达', fulfillment: 'FBA', purchasedAt: '2026-10-17 08:40', items: 1 },
]
export const inventory = [
  { sku: 'NS-ORGANIZER-01', title: '模块化桌面收纳架', store: 'Northstar US', available: 2480, inbound: 620, reserved: 184, days: 42, status: '健康' },
  { sku: 'NS-BAG-02-BLK', title: '通勤旅行收纳包 · 黑色', store: 'Northstar US', available: 384, inbound: 0, reserved: 91, days: 8, status: '需补货' },
  { sku: 'OP-CABLE-03', title: '桌面理线套装', store: 'Oak & Pine CA', available: 812, inbound: 240, reserved: 34, days: 19, status: '关注' },
  { sku: 'NS-LAMP-04', title: '便携阅读灯', store: 'Northstar UK', available: 96, inbound: 480, reserved: 22, days: 5, status: '缺货风险' },
]
export const syncJobs = [
  { id: 'SYNC-20261017-0194', type: '订单与退款', store: 'Northstar US', status: '运行中', progress: 72, created: '10:42:11', owner: '系统调度' },
  { id: 'SYNC-20261017-0193', type: '库存快照', store: 'Northstar UK', status: '已完成', progress: 100, created: '10:31:08', owner: '系统调度' },
  { id: 'SYNC-20261017-0192', type: '财务事件', store: 'Northstar DE', status: '失败', progress: 41, created: '10:14:37', owner: '系统调度' },
]
