-- Pagamentos mais seguros: compras de uma só vez, reembolsos e eventos fora de ordem.
-- AlterTable
ALTER TABLE "SubscriptionPlan" ADD COLUMN     "oneTimeProducts" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'SUBSCRIPTION',
ADD COLUMN     "lastEventAt" TIMESTAMP(3),
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "endingNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "endNotifiedAt" TIMESTAMP(3);

-- Os planos que já tinham acabado antes desta versão não geram avisos agora.
UPDATE "Subscription" SET "endNotifiedAt" = NOW()
WHERE "status" = 'EXPIRED' OR ("expirationDate" IS NOT NULL AND "expirationDate" < NOW());
