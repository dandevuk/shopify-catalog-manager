-- CreateEnum
CREATE TYPE "CatalogType" AS ENUM ('MARKET', 'COMPANY_LOCATION');

-- CreateEnum
CREATE TYPE "RuleSetKind" AS ENUM ('CATALOG', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "MatchMode" AS ENUM ('ALL', 'ANY');

-- CreateEnum
CREATE TYPE "ConditionGroup" AS ENUM ('INCLUDE', 'EXCLUDE');

-- CreateEnum
CREATE TYPE "OverrideKind" AS ENUM ('PIN', 'BLOCK');

-- CreateEnum
CREATE TYPE "OverrideSource" AS ENUM ('APP', 'ADMIN_EDIT');

-- CreateEnum
CREATE TYPE "SyncCause" AS ENUM ('RULE_CHANGE', 'WEBHOOK', 'DRIFT', 'RECONCILE', 'MANUAL');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PAUSED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('ADD', 'REMOVE');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "planName" TEXT,
    "isPlus" BOOLEAN NOT NULL DEFAULT false,
    "b2bCatalogLimit" INTEGER,
    "billingStatus" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Catalog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyCatalogId" TEXT NOT NULL,
    "publicationId" TEXT,
    "type" "CatalogType" NOT NULL,
    "title" TEXT NOT NULL,
    "managed" BOOLEAN NOT NULL DEFAULT false,
    "templateId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastOperationId" TEXT,
    "lastKnownCount" INTEGER,
    "lastAutoPublish" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleSet" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" "RuleSetKind" NOT NULL,
    "name" TEXT,
    "catalogId" TEXT,
    "includeMatch" "MatchMode" NOT NULL DEFAULT 'ALL',
    "excludeMatch" "MatchMode" NOT NULL DEFAULT 'ANY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuleSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Condition" (
    "id" TEXT NOT NULL,
    "ruleSetId" TEXT NOT NULL,
    "group" "ConditionGroup" NOT NULL,
    "field" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "value" TEXT,
    "metafieldDefinitionId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Override" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" "OverrideKind" NOT NULL,
    "reason" TEXT,
    "source" "OverrideSource" NOT NULL DEFAULT 'APP',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductIndex" (
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "status" TEXT NOT NULL,
    "vendor" TEXT,
    "productType" TEXT,
    "tags" TEXT[],
    "categoryId" TEXT,
    "collectionIds" TEXT[],
    "onlineStorePublished" BOOLEAN NOT NULL DEFAULT false,
    "variantSummary" JSONB,
    "metafields" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductIndex_pkey" PRIMARY KEY ("shopId","productId")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "cause" "SyncCause" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "adds" INTEGER NOT NULL DEFAULT 0,
    "removes" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLogEntry" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "cause" "SyncCause" NOT NULL,
    "ruleSummary" TEXT,
    "syncJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "Catalog_shopId_shopifyCatalogId_key" ON "Catalog"("shopId", "shopifyCatalogId");

-- CreateIndex
CREATE UNIQUE INDEX "RuleSet_catalogId_key" ON "RuleSet"("catalogId");

-- CreateIndex
CREATE INDEX "Condition_ruleSetId_idx" ON "Condition"("ruleSetId");

-- CreateIndex
CREATE UNIQUE INDEX "Override_catalogId_productId_key" ON "Override"("catalogId", "productId");

-- CreateIndex
CREATE INDEX "SyncJob_catalogId_createdAt_idx" ON "SyncJob"("catalogId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLogEntry_catalogId_productId_idx" ON "AuditLogEntry"("catalogId", "productId");

-- CreateIndex
CREATE INDEX "AuditLogEntry_catalogId_createdAt_idx" ON "AuditLogEntry"("catalogId", "createdAt");

-- AddForeignKey
ALTER TABLE "Catalog" ADD CONSTRAINT "Catalog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Catalog" ADD CONSTRAINT "Catalog_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "RuleSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleSet" ADD CONSTRAINT "RuleSet_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleSet" ADD CONSTRAINT "RuleSet_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Condition" ADD CONSTRAINT "Condition_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Override" ADD CONSTRAINT "Override_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIndex" ADD CONSTRAINT "ProductIndex_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
