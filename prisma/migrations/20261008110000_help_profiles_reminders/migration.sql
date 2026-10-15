-- Parte 7: quem acompanha pode ajudar a gerir (com registo do que muda), "sobre mim" no perfil.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bio" VARCHAR(160);

-- AlterTable
ALTER TABLE "SharedAccess" ADD COLUMN     "manageSections" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "SharedActivity" (
    "id" TEXT NOT NULL,
    "accessId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "section" VARCHAR(20) NOT NULL,
    "action" VARCHAR(10) NOT NULL,
    "label" VARCHAR(160),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SharedActivity_accessId_createdAt_idx" ON "SharedActivity"("accessId", "createdAt");

-- AddForeignKey
ALTER TABLE "SharedActivity" ADD CONSTRAINT "SharedActivity_accessId_fkey" FOREIGN KEY ("accessId") REFERENCES "SharedAccess"("id") ON DELETE CASCADE ON UPDATE CASCADE;
