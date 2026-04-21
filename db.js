const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function prepareSqliteForLoad() {
  try {
    // SQLite foreign keys are OFF by default; enabling avoids orphaned relations.
    await prisma.$queryRawUnsafe("PRAGMA foreign_keys=ON;");
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
    await prisma.$queryRawUnsafe("PRAGMA synchronous = NORMAL;");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000;");
    console.log("SQLite PRAGMAs applied ✅");
  } catch (e) {
    console.error("Failed to set SQLite PRAGMAs", e);
  }
}

module.exports = { prisma, prepareSqliteForLoad };
