const { Markup } = require("telegraf");

const PLANS = {
  M1: { label: "1 месяц", price: 100, months: 1, type: "M1" },
  M3: { label: "3 месяца", price: 270, months: 3, type: "M3" },
  M6: { label: "6 месяцев", price: 520, months: 6, type: "M6" },
  M12: { label: "12 месяцев", price: 1000, months: 12, type: "M12" },
};
const TOPUP_AMOUNTS = [100, 270, 520, 1000];

function ruMoney(v) {
  return `${v} ₽`;
}
function formatDate(d) {
  return d ? new Date(d).toLocaleDateString("ru-RU") : "∞";
}
function calcEndDate(months) {
  const now = new Date();
  const dt = new Date(now);
  dt.setMonth(dt.getMonth() + months);
  return dt;
}

function getDisplayLabel(sub) {
  if (sub.type === "FREE") return "Free";

  if (sub.startDate && sub.endDate) {
    const start = new Date(sub.startDate);
    const end = new Date(sub.endDate);

    // разница в днях
    const diffDays = Math.round((end - start) / (1000 * 60 * 60 * 24));

    // переводим в месяцы (приблизительно по 30 дней)
    const months = Math.round(diffDays / 30);

    return `${months} мес.`;
  }

  return PLANS[sub.type]?.label || sub.type;
}




function mainMenu(balanceRub = 0) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📋 Информация", "info")],
    [Markup.button.callback("💳 Купить подписку", "buy")],
    [Markup.button.callback(`💼 Баланс: ${ruMoney(balanceRub)}`, "balance")],
    [Markup.button.callback("📦 Мои подписки", "my_subs")],
  ]);
}

function buyMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${PLANS.M1.label} — ${ruMoney(PLANS.M1.price)}`, "buy_M1")],
    [Markup.button.callback(`${PLANS.M3.label} — ${ruMoney(PLANS.M3.price)}`, "buy_M3")],
    [Markup.button.callback(`${PLANS.M6.label} — ${ruMoney(PLANS.M6.price)}`, "buy_M6")],
    [Markup.button.callback(`${PLANS.M12.label} — ${ruMoney(PLANS.M12.price)}`, "buy_M12")],
    [Markup.button.callback("⬅️ Назад", "back")],
  ]);
}


function topupMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`+ ${ruMoney(100)}`, "topup_100")],
    [Markup.button.callback(`+ ${ruMoney(270)}`, "topup_270")],
    [Markup.button.callback(`+ ${ruMoney(520)}`, "topup_520")],
    [Markup.button.callback(`+ ${ruMoney(1000)}`, "topup_1000")],
    [Markup.button.callback("⬅️ Назад", "back")],
  ]);
}

module.exports = {
  PLANS,
  TOPUP_AMOUNTS,
  ruMoney,
  formatDate,
  calcEndDate,
  mainMenu,
  buyMenu,
  topupMenu,
  getDisplayLabel, // 👈 добавляем сюда
};
