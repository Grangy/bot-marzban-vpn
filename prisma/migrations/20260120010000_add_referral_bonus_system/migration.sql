-- Migration: Add referral bonus system
-- This migration adds ReferralBonus table and updates PromoActivation

-- Step 1: Remove amount field from PromoActivation (no longer needed)
-- We'll keep the table structure but amount is no longer used
-- Note: SQLite doesn't support DROP COLUMN easily, so we'll leave it for now
-- The amount field will just be ignored by Prisma schema

-- Step 2: Create ReferralBonus table
CREATE TABLE "ReferralBonus" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "codeOwnerId" INTEGER NOT NULL,
    "activatorId" INTEGER NOT NULL,
    "topupId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "bonusAmount" INTEGER NOT NULL,
    "credited" BOOLEAN NOT NULL DEFAULT false,
    "creditedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferralBonus_codeOwnerId_fkey" FOREIGN KEY ("codeOwnerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReferralBonus_activatorId_fkey" FOREIGN KEY ("activatorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReferralBonus_topupId_fkey" FOREIGN KEY ("topupId") REFERENCES "TopUp" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Step 3: Create indexes for ReferralBonus
CREATE INDEX "ReferralBonus_codeOwnerId_createdAt_idx" ON "ReferralBonus"("codeOwnerId", "createdAt");
CREATE INDEX "ReferralBonus_activatorId_idx" ON "ReferralBonus"("activatorId");
CREATE INDEX "ReferralBonus_topupId_idx" ON "ReferralBonus"("topupId");
