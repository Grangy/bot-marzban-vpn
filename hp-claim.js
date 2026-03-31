// hp-claim.js — обработка /start hp_claim_<token> (redeem на сайте → привязка TG → бонус)

const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

function getClaimConfig() {
  const baseUrl = (process.env.CLAIM_API_BASE_URL || "").replace(/\/$/, "");
  const apiKey = process.env.CLAIM_API_KEY || "";
  return { baseUrl, apiKey };
}

async function redeemClaim({ token, telegramId, username }) {
  const { baseUrl, apiKey } = getClaimConfig();
  if (!baseUrl) throw new Error("CLAIM_API_BASE_URL not set");
  if (!apiKey) throw new Error("CLAIM_API_KEY not set");

  const url = `${baseUrl}/api/claim/redeem`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ token, telegramId: Number(telegramId), username: username || null }),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  return {
    ok: res.ok,
    status: res.status,
    data: json,
    text,
  };
}

module.exports = { redeemClaim };

