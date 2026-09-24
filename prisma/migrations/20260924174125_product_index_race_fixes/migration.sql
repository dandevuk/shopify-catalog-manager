-- AlterTable
ALTER TABLE "ProductIndex" ADD COLUMN     "collectionsReadAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProductIndexDeletion" (
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductIndexDeletion_pkey" PRIMARY KEY ("shopId","productId")
);

-- AddForeignKey
ALTER TABLE "ProductIndexDeletion" ADD CONSTRAINT "ProductIndexDeletion_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
