-- Entrar com o Google: a palavra-passe passa a ser opcional (contas só com
-- Google), guarda-se o identificador da conta Google e quando o email ficou
-- confirmado.

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL,
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "googleId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
