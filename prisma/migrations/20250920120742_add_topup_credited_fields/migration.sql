/*
  Warnings:

  - Added the required column `updatedAt` to the `TopUp` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TopUp" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "orderId" TEXT NOT NULL,
    "billId" TEXT,
    "credited" BOOLEAN NOT NULL DEFAULT false,
    "creditedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TopUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TopUp" ("amount", "billId", "createdAt", "id", "orderId", "status", "userId") SELECT "amount", "billId", "createdAt", "id", "orderId", "status", "userId" FROM "TopUp";
DROP TABLE "TopUp";
ALTER TABLE "new_TopUp" RENAME TO "TopUp";
CREATE UNIQUE INDEX "TopUp_orderId_key" ON "TopUp"("orderId");
CREATE INDEX "TopUp_userId_createdAt_idx" ON "TopUp"("userId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
