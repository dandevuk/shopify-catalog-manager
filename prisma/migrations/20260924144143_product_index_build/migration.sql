-- CreateEnum
CREATE TYPE "IndexBuildStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "ProductIndex" ADD COLUMN     "shopifyUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "onlineStorePublicationId" TEXT,
ADD COLUMN     "productIndexError" TEXT,
ADD COLUMN     "productIndexOperationId" TEXT,
ADD COLUMN     "productIndexRebuiltAt" TIMESTAMP(3),
ADD COLUMN     "productIndexStartedAt" TIMESTAMP(3),
ADD COLUMN     "productIndexStatus" "IndexBuildStatus";
