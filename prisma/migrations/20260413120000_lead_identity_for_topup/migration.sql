-- CreateTable
CREATE TABLE "LeadIdentity" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "leadType" TEXT NOT NULL,
    "leadCode" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadIdentity_userId_key" ON "LeadIdentity"("userId");

-- CreateIndex
CREATE INDEX "LeadIdentity_leadType_idx" ON "LeadIdentity"("leadType");

-- CreateIndex
CREATE UNIQUE INDEX "LeadIdentity_leadType_leadCode_key" ON "LeadIdentity"("leadType", "leadCode");
