export function purchaseOrdersWhere(tenantId: string, query: Record<string, string>) {
  return {
    tenantId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.q ? { number: { contains: query.q, mode: 'insensitive' as const } } : {}),
  }
}

// 采购单草稿的写入数据。币种默认取供应商币种；单价缺省时保持为空，不以 0 代替。
export function purchaseOrderCreateData(tenantId: string, supplier: { id: string; currency: string }, number: string, raw: Record<string, unknown>, lines: Array<Record<string, unknown>>) {
  return {
    tenantId,
    supplierId: supplier.id,
    number,
    status: 'DRAFT',
    currency: String(raw.currency ?? supplier.currency),
    expectedDate: raw.expectedDate ? new Date(String(raw.expectedDate)) : undefined,
    notes: typeof raw.notes === 'string' ? raw.notes : undefined,
    lines: {
      create: lines.map(line => ({
        sellerSku: String(line.sellerSku ?? ''),
        asin: typeof line.asin === 'string' ? line.asin : undefined,
        title: typeof line.title === 'string' ? line.title : undefined,
        quantity: Number(line.quantity ?? 0),
        unitCost: line.unitCost === undefined ? undefined : Number(line.unitCost),
        currency: String(line.currency ?? raw.currency ?? supplier.currency),
      })),
    },
  }
}
