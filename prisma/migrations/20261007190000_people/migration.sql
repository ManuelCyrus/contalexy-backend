-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3),
ADD COLUMN     "deletionScheduledFor" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "ip" TEXT,
ADD COLUMN     "sessionId" TEXT;

-- AlterTable
ALTER TABLE "Space" ADD COLUMN     "editBy" TEXT NOT NULL DEFAULT 'OWN',
ADD COLUMN     "expensesBy" TEXT NOT NULL DEFAULT 'ALL',
ADD COLUMN     "inviteBy" TEXT NOT NULL DEFAULT 'ALL';

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "counterpartId" TEXT,
ADD COLUMN     "counterpartPinnedAt" TIMESTAMP(3),
ADD COLUMN     "linkRespondedAt" TIMESTAMP(3),
ADD COLUMN     "linkStatus" TEXT;

-- AlterTable
ALTER TABLE "LoanPayment" ADD COLUMN     "createdById" TEXT;

-- CreateTable
CREATE TABLE "LoginEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "userAgent" TEXT,
    "ip" TEXT,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpaceActivity" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpaceActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyPlanOffer" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "note" TEXT,
    "plannedIncome" DECIMAL(18,2),
    "plannedSavings" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL,
    "lines" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "appliedKey" TEXT,
    "accessId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "MonthlyPlanOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginEvent_userId_createdAt_idx" ON "LoginEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SpaceActivity_spaceId_createdAt_idx" ON "SpaceActivity"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "MonthlyPlanOffer_toUserId_status_idx" ON "MonthlyPlanOffer"("toUserId", "status");

-- CreateIndex
CREATE INDEX "MonthlyPlanOffer_fromUserId_createdAt_idx" ON "MonthlyPlanOffer"("fromUserId", "createdAt");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_sessionId_idx" ON "RefreshToken"("userId", "sessionId");

-- CreateIndex
CREATE INDEX "Loan_counterpartId_linkStatus_idx" ON "Loan"("counterpartId", "linkStatus");

-- AddForeignKey
ALTER TABLE "LoginEvent" ADD CONSTRAINT "LoginEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceActivity" ADD CONSTRAINT "SpaceActivity_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_counterpartId_fkey" FOREIGN KEY ("counterpartId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyPlanOffer" ADD CONSTRAINT "MonthlyPlanOffer_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyPlanOffer" ADD CONSTRAINT "MonthlyPlanOffer_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
