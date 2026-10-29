-- M-P1-12：成员数据范围 MembershipScope；AdsProfile 绑定店铺字段。
-- 回滚方法见同目录 rollback.sql（先加后删：本迁移只新增表与列，不删除任何已有数据）。

CREATE TABLE "MembershipScope" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "membershipId" TEXT NOT NULL,
  "legalEntityId" TEXT,
  "sellerAccountId" TEXT,
  "grantedBy" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipScope_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MembershipScope_membershipId_legalEntityId_sellerAccountId_key" ON "MembershipScope"("membershipId", "legalEntityId", "sellerAccountId");
CREATE INDEX "MembershipScope_tenantId_membershipId_idx" ON "MembershipScope"("tenantId", "membershipId");
CREATE INDEX "MembershipScope_legalEntityId_idx" ON "MembershipScope"("legalEntityId");
CREATE INDEX "MembershipScope_sellerAccountId_idx" ON "MembershipScope"("sellerAccountId");

ALTER TABLE "MembershipScope" ADD CONSTRAINT "MembershipScope_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipScope" ADD CONSTRAINT "MembershipScope_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipScope" ADD CONSTRAINT "MembershipScope_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipScope" ADD CONSTRAINT "MembershipScope_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 保持现有成员的访问不变：每个已有成员授予“全部范围”（两列都为空）。
INSERT INTO "MembershipScope" ("id", "tenantId", "membershipId", "grantedBy", "note")
SELECT 'ms_' || "id", "tenantId", "id", 'system:migration', '迁移：保持原有的全部数据范围'
FROM "Membership";

-- 广告账户绑定店铺
ALTER TABLE "AdsProfile" ADD COLUMN "sellerAccountId" TEXT;
ALTER TABLE "AdsProfile" ADD COLUMN "bindingStatus" TEXT NOT NULL DEFAULT 'UNBOUND';
ALTER TABLE "AdsProfile" ADD COLUMN "boundBy" TEXT;
ALTER TABLE "AdsProfile" ADD CONSTRAINT "AdsProfile_bindingStatus_check" CHECK ("bindingStatus" IN ('AUTO_MATCHED', 'MANUAL', 'UNBOUND'));
ALTER TABLE "AdsProfile" ADD CONSTRAINT "AdsProfile_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "AdsProfile_sellerAccountId_idx" ON "AdsProfile"("sellerAccountId");

-- 自动匹配：广告账户的卖家编号与店铺的卖家编号一致，且同租户内只有唯一一个候选店铺时才绑定。
UPDATE "AdsProfile" p
SET "sellerAccountId" = m."id", "bindingStatus" = 'AUTO_MATCHED'
FROM (
  SELECT p2."id" AS profile_id, (array_agg(s."id"))[1] AS "id"
  FROM "AdsProfile" p2
  JOIN "SellerAccount" s ON s."tenantId" = p2."tenantId" AND s."sellerId" = p2."accountId"
  WHERE p2."accountId" IS NOT NULL
  GROUP BY p2."id"
  HAVING count(*) = 1
) m
WHERE p."id" = m.profile_id;
