ALTER TABLE "PlatformConnection" ADD COLUMN "encryptedRefreshToken" TEXT;
ALTER TABLE "PlatformConnection" ADD COLUMN "refreshTokenUpdatedAt" TIMESTAMP(3);
ALTER TABLE "OAuthState" ADD COLUMN "legalEntityId" TEXT;
CREATE INDEX "OAuthState_legalEntityId_idx" ON "OAuthState"("legalEntityId");
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
