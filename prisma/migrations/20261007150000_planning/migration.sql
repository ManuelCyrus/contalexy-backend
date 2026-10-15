-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "items" JSONB,
ADD COLUMN     "itemsText" TEXT;

-- AlterTable
ALTER TABLE "GoalContribution" ADD COLUMN     "depositId" TEXT;

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "periodKey" TEXT;

-- CreateTable
CREATE TABLE "GoalDeposit" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'ONCE',
    "startDate" DATE NOT NULL,
    "nextDate" DATE NOT NULL,
    "endDate" DATE,
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastReminderFor" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoalDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoalDeposit_goalId_idx" ON "GoalDeposit"("goalId");

-- CreateIndex
CREATE INDEX "GoalDeposit_userId_idx" ON "GoalDeposit"("userId");

-- CreateIndex
CREATE INDEX "GoalDeposit_isActive_nextDate_idx" ON "GoalDeposit"("isActive", "nextDate");

-- CreateIndex
CREATE INDEX "Plan_userId_periodKey_idx" ON "Plan"("userId", "periodKey");

-- AddForeignKey
ALTER TABLE "GoalDeposit" ADD CONSTRAINT "GoalDeposit_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
