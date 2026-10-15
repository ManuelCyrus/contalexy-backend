-- Parte 8: utilização por período, códigos com áreas fechadas, bancos de referência, feedback, privilégios dos grupos
ALTER TABLE "User" ADD COLUMN "signupPlatform" VARCHAR(16), ADD COLUMN "signupCampaign" VARCHAR(60);
ALTER TABLE "Account" ADD COLUMN "institutionId" TEXT;
ALTER TABLE "PromoCode" ADD COLUMN "blockedAreas" TEXT[] DEFAULT ARRAY[]::TEXT[], ADD COLUMN "blockedFeatures" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PromoRedemption" ADD COLUMN "plan" TEXT, ADD COLUMN "activatedAt" TIMESTAMP(3), ADD COLUMN "expiresAt" TIMESTAMP(3), ADD COLUMN "subscriptionId" TEXT;
ALTER TABLE "AiUsage" ADD COLUMN "requestKey" TEXT, ADD COLUMN "result" JSONB;
CREATE UNIQUE INDEX "AiUsage_requestKey_key" ON "AiUsage"("requestKey");
ALTER TABLE "Space" ADD COLUMN "privileges" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feature" VARCHAR(40) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "plan" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UsageCounter_userId_feature_periodStart_key" ON "UsageCounter"("userId", "feature", "periodStart");
CREATE INDEX "UsageCounter_userId_idx" ON "UsageCounter"("userId");
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Institution" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "country" VARCHAR(2),
    "logoUrl" TEXT,
    "logoKey" TEXT,
    "website" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Institution_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Institution_country_idx" ON "Institution"("country");

CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "appVersion" VARCHAR(40),
    "platform" VARCHAR(16),
    "status" VARCHAR(16) NOT NULL DEFAULT 'NEW',
    "adminNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Feedback_status_createdAt_idx" ON "Feedback"("status", "createdAt");
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
