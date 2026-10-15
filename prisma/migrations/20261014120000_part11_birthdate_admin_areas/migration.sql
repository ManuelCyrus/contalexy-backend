-- Data de nascimento e áreas de administração por admin
ALTER TABLE "User" ADD COLUMN "adminAreas" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "User" ADD COLUMN "birthDate" DATE;
