-- Migration: Add advanced promo system
-- This migration safely updates AdminPromo table and creates AdminPromoActivation table

-- Step 1: Create new AdminPromo table with additional fields
CREATE TABLE "new_AdminPromo" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL UNIQUE,
    "type" TEXT NOT NULL DEFAULT 'BALANCE',
    "amount" INTEGER,
    "days" INTEGER,
    "isReusable" BOOLEAN NOT NULL DEFAULT false,
    "customName" TEXT,
    "usedById" INTEGER,
    "usedAt" DATETIME,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT
);

-- Step 2: Copy existing data from old table to new table
-- All existing promos are treated as BALANCE type
INSERT INTO "new_AdminPromo" (
    "id", "code", "type", "amount", "days", "isReusable", "customName", 
    "usedById", "usedAt", "useCount", "createdAt", "createdBy"
)
SELECT 
    "id", 
    "code", 
    'BALANCE' as "type",
    "amount",
    NULL as "days",
    false as "isReusable",
    NULL as "customName",
    "usedById",
    "usedAt",
    0 as "useCount",
    "createdAt",
    "createdBy"
FROM "AdminPromo";

-- Step 3: Drop old table
DROP TABLE "AdminPromo";

-- Step 4: Rename new table to AdminPromo
ALTER TABLE "new_AdminPromo" RENAME TO "AdminPromo";

-- Step 5: Recreate indexes
CREATE INDEX "AdminPromo_code_idx" ON "AdminPromo"("code");
CREATE INDEX "AdminPromo_type_createdAt_idx" ON "AdminPromo"("type", "createdAt");

-- Step 6: Create AdminPromoActivation table
CREATE TABLE "AdminPromoActivation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "promoId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "activatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminPromoActivation_promoId_fkey" FOREIGN KEY ("promoId") REFERENCES "AdminPromo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AdminPromoActivation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Step 7: Create unique constraint and indexes for AdminPromoActivation
CREATE UNIQUE INDEX "AdminPromoActivation_promoId_userId_key" ON "AdminPromoActivation"("promoId", "userId");
CREATE INDEX "AdminPromoActivation_promoId_idx" ON "AdminPromoActivation"("promoId");
CREATE INDEX "AdminPromoActivation_userId_idx" ON "AdminPromoActivation"("userId");
