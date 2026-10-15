-- Parte 10: investimentos e dividendos, importação, WhatsApp e movimentos por confirmar
CREATE TABLE "Investment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "type" VARCHAR(16) NOT NULL DEFAULT 'OTHER',
    "currency" VARCHAR(3) NOT NULL,
    "invested" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currentValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "units" DECIMAL(18,6),
    "expectedYield" DECIMAL(8,3),
    "note" VARCHAR(300),
    "accountId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "valuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Investment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Investment_userId_idx" ON "Investment"("userId");
ALTER TABLE "Investment" ADD CONSTRAINT "Investment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Dividend" (
    "id" TEXT NOT NULL,
    "investmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "date" DATE NOT NULL,
    "expected" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(200),
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Dividend_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Dividend_userId_date_idx" ON "Dividend"("userId", "date");
CREATE INDEX "Dividend_investmentId_idx" ON "Dividend"("investmentId");
ALTER TABLE "Dividend" ADD CONSTRAINT "Dividend_investmentId_fkey" FOREIGN KEY ("investmentId") REFERENCES "Investment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Dividend" ADD CONSTRAINT "Dividend_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WhatsappLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" VARCHAR(20),
    "linkCode" VARCHAR(12),
    "linkCodeExpiresAt" TIMESTAMP(3),
    "consentAt" TIMESTAMP(3),
    "linkedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WhatsappLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WhatsappLink_userId_key" ON "WhatsappLink"("userId");
CREATE UNIQUE INDEX "WhatsappLink_phone_key" ON "WhatsappLink"("phone");
CREATE UNIQUE INDEX "WhatsappLink_linkCode_key" ON "WhatsappLink"("linkCode");
ALTER TABLE "WhatsappLink" ADD CONSTRAINT "WhatsappLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PendingTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "sourceId" TEXT,
    "type" VARCHAR(10) NOT NULL DEFAULT 'EXPENSE',
    "amount" DECIMAL(18,2),
    "currency" VARCHAR(3),
    "date" DATE,
    "description" VARCHAR(140),
    "merchant" VARCHAR(80),
    "categoryKey" VARCHAR(30),
    "attachmentId" TEXT,
    "items" JSONB,
    "rawText" VARCHAR(2000),
    "status" VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PendingTransaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PendingTransaction_sourceId_key" ON "PendingTransaction"("sourceId");
CREATE INDEX "PendingTransaction_userId_status_createdAt_idx" ON "PendingTransaction"("userId", "status", "createdAt");
ALTER TABLE "PendingTransaction" ADD CONSTRAINT "PendingTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileName" VARCHAR(160) NOT NULL,
    "columns" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "mapping" JSONB,
    "rowCount" INTEGER NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'PREVIEW',
    "imported" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ImportBatch_userId_createdAt_idx" ON "ImportBatch"("userId", "createdAt");
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
