-- O teto mensal de IA (AI_MONTHLY_BUDGET_USD) passa a contar só o que gasta o plano grátis.
ALTER TABLE "AiUsage" ADD COLUMN "free" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "AiUsage_free_createdAt_idx" ON "AiUsage"("free", "createdAt");
