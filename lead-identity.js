// lead-identity.js — лиды для оплаты без telegramId (lead_type + 7-символьный код)

const LEAD_TELEGRAM_PREFIX = "lead:";

function normalizeLeadType(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (!/^[a-z0-9_]{1,32}$/.test(s)) {
    const err = new Error("INVALID_LEAD_TYPE");
    err.code = "INVALID_LEAD_TYPE";
    throw err;
  }
  return s;
}

function normalizeLeadCode(raw) {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{7}$/.test(s)) {
    const err = new Error("INVALID_LEAD_CODE");
    err.code = "INVALID_LEAD_CODE";
    throw err;
  }
  return s;
}

/**
 * Найти пользователя по leadType+leadCode или создать User с синтетическим telegramId/chatId.
 * @returns {Promise<{ user: import("@prisma/client").User, leadType: string, leadCode: string, created: boolean }>}
 */
async function getOrCreateUserForLead(prismaClient, leadTypeRaw, leadCodeRaw) {
  const leadType = normalizeLeadType(leadTypeRaw);
  const leadCode = normalizeLeadCode(leadCodeRaw);

  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await prismaClient.leadIdentity.findUnique({
      where: { leadType_leadCode: { leadType, leadCode } },
      include: { user: true },
    });
    if (existing?.user) {
      return { user: existing.user, leadType, leadCode, created: false };
    }

    const tg = `${LEAD_TELEGRAM_PREFIX}${leadType}:${leadCode}`;
    try {
      const out = await prismaClient.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: { telegramId: tg, chatId: tg, balance: 0 },
        });
        await tx.leadIdentity.create({
          data: { leadType, leadCode, userId: u.id },
        });
        return { user: u, leadType, leadCode, created: true };
      });
      return out;
    } catch (e) {
      if (e?.code === "P2002" && attempt < 2) continue;
      throw e;
    }
  }

  throw new Error("LEAD_CREATE_RETRY_EXHAUSTED");
}

/**
 * Только поиск существующего лида (без создания). Невалидные lead_* → null.
 * @returns {Promise<import("@prisma/client").User | null>}
 */
async function findUserByLead(prismaClient, leadTypeRaw, leadCodeRaw) {
  let leadType;
  let leadCode;
  try {
    leadType = normalizeLeadType(leadTypeRaw);
    leadCode = normalizeLeadCode(leadCodeRaw);
  } catch {
    return null;
  }
  const row = await prismaClient.leadIdentity.findUnique({
    where: { leadType_leadCode: { leadType, leadCode } },
    include: { user: true },
  });
  return row?.user ?? null;
}

module.exports = {
  normalizeLeadType,
  normalizeLeadCode,
  getOrCreateUserForLead,
  findUserByLead,
  LEAD_TELEGRAM_PREFIX,
};
