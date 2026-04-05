#!/usr/bin/env node
/**
 * Prisma Studio на копии продовой БД (prisma/dev.db.prod).
 * DATABASE_URL задаётся абсолютным путём — иначе Studio часто даёт SQLite error 14
 * из‑за смешения с .env и разного cwd.
 */
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const dbFile = path.join(root, "prisma", "dev.db.prod");

if (!fs.existsSync(dbFile)) {
  console.error(`Файл не найден: ${dbFile}`);
  console.error("Скопируйте БД с прода, например: scp …:/opt/bot-marzban-vpn/prisma/dev.db ./prisma/dev.db.prod");
  process.exit(1);
}

const databaseUrl = "file:" + dbFile;
const env = { ...process.env, DATABASE_URL: databaseUrl };

const extra = process.argv.slice(2);
const args = ["prisma", "studio", ...extra];

const result = spawnSync("npx", args, {
  cwd: root,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
