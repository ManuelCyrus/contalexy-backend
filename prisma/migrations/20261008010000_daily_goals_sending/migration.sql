-- Limite diário, objetivos com início e passos, preço por unidade nos planos,
-- enviar objetivos/planos/limites a outra pessoa e o que cada acompanhante pode ver.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dailyLimit" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "startDate" DATE;

-- AlterTable
ALTER TABLE "PlanItem" ADD COLUMN     "unitPrice" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "MonthlyPlanLine" ADD COLUMN     "list" BOOLEAN;

-- AlterTable
ALTER TABLE "SharedAccess" ADD COLUMN     "hiddenCategoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sections" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "DailyLimitDay" (
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(18,2),
    "alertLevel" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyLimitDay_pkey" PRIMARY KEY ("userId","date")
);

-- CreateTable
CREATE TABLE "GoalStep" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(18,2),
    "dueDate" DATE,
    "doneAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemOffer" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "currency" VARCHAR(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "ItemOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoalStep_goalId_idx" ON "GoalStep"("goalId");

-- CreateIndex
CREATE INDEX "ItemOffer_toUserId_status_idx" ON "ItemOffer"("toUserId", "status");

-- CreateIndex
CREATE INDEX "ItemOffer_fromUserId_createdAt_idx" ON "ItemOffer"("fromUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "DailyLimitDay" ADD CONSTRAINT "DailyLimitDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalStep" ADD CONSTRAINT "GoalStep_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemOffer" ADD CONSTRAINT "ItemOffer_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemOffer" ADD CONSTRAINT "ItemOffer_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Quem já acompanhava continua a ver exatamente o que via (as secções novas ficam por dar).
UPDATE "SharedAccess" SET "sections" = CASE WHEN "scope" = 'FULL' THEN ARRAY['income','plan','budgets','goals','transactions'] ELSE ARRAY['income','plan','budgets','goals'] END;
