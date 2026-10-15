-- Parte 9: créditos de IA
ALTER TABLE "User" ADD COLUMN "aiCredits" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "AiCreditEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" VARCHAR(16) NOT NULL,
    "productId" TEXT,
    "eventId" TEXT,
    "note" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiCreditEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiCreditEvent_eventId_key" ON "AiCreditEvent"("eventId");
CREATE INDEX "AiCreditEvent_userId_createdAt_idx" ON "AiCreditEvent"("userId", "createdAt");
ALTER TABLE "AiCreditEvent" ADD CONSTRAINT "AiCreditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
