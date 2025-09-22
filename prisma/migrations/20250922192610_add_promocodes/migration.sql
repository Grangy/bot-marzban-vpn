/*
  Warnings:

  - A unique constraint covering the columns `[promoCode]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN "promoCode" TEXT;

-- CreateTable
CREATE TABLE "PromoActivation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "codeOwnerId" INTEGER NOT NULL,
    "activatorId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 100,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromoActivation_codeOwnerId_fkey" FOREIGN KEY ("codeOwnerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PromoActivation_activatorId_fkey" FOREIGN KEY ("activatorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoActivation_activatorId_key" ON "PromoActivation"("activatorId");

-- CreateIndex
CREATE INDEX "PromoActivation_codeOwnerId_createdAt_idx" ON "PromoActivation"("codeOwnerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_promoCode_key" ON "User"("promoCode");
