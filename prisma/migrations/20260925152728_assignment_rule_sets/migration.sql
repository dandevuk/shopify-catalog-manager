-- AlterEnum
ALTER TYPE "RuleSetKind" ADD VALUE 'ASSIGNMENT';

-- DropIndex
DROP INDEX "RuleSet_catalogId_key";

-- CreateIndex
CREATE UNIQUE INDEX "RuleSet_catalogId_kind_key" ON "RuleSet"("catalogId", "kind");
