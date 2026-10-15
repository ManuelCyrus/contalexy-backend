-- AlterTable
ALTER TABLE "SpaceExpense" ADD COLUMN     "fromPot" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SpaceDeposit" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "goalId" TEXT,
    "date" DATE NOT NULL,
    "note" TEXT,
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpaceDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpaceGoal" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'flag',
    "color" TEXT NOT NULL DEFAULT '#12B886',
    "targetAmount" DECIMAL(18,2) NOT NULL,
    "targetDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpaceGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpacePlanLine" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "categoryKey" TEXT,
    "title" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SpacePlanLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT,
    "directKey" TEXT,
    "senderId" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatRead" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "thread" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpaceDeposit_spaceId_date_idx" ON "SpaceDeposit"("spaceId", "date");

-- CreateIndex
CREATE INDEX "SpaceDeposit_userId_idx" ON "SpaceDeposit"("userId");

-- CreateIndex
CREATE INDEX "SpaceGoal_spaceId_idx" ON "SpaceGoal"("spaceId");

-- CreateIndex
CREATE INDEX "SpacePlanLine_spaceId_idx" ON "SpacePlanLine"("spaceId");

-- CreateIndex
CREATE INDEX "Message_spaceId_createdAt_idx" ON "Message"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_directKey_createdAt_idx" ON "Message"("directKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatRead_userId_thread_key" ON "ChatRead"("userId", "thread");

-- AddForeignKey
ALTER TABLE "SpaceDeposit" ADD CONSTRAINT "SpaceDeposit_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceDeposit" ADD CONSTRAINT "SpaceDeposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceDeposit" ADD CONSTRAINT "SpaceDeposit_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "SpaceGoal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceGoal" ADD CONSTRAINT "SpaceGoal_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpacePlanLine" ADD CONSTRAINT "SpacePlanLine_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatRead" ADD CONSTRAINT "ChatRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
