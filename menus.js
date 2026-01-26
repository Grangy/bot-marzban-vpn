const {
  Markup
} = require("telegraf");

const PLANS = {
  M1: {
    label: "1 месяц",
    price: 120,
    months: 1,
    type: "M1"
  },
  M3: {
    label: "3 месяца",
    price: 330,
    months: 3,
    type: "M3"
  },
  M6: {
    label: "6 месяцев",
    price: 570,
    months: 6,
    type: "M6"
  },
  M12: {
    label: "12 месяцев",
    price: 1140,
    months: 12,
    type: "M12"
  },
  PROMO_10D: {
    label: "10 дней (промо)",
    price: 0,
    days: 10,
    type: "PROMO_10D"
  },
};
const TOPUP_AMOUNTS = [120, 330, 570, 1140];

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
  if (sub.type === "PROMO_10D") return "10 дней (промо)";

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


function infoMenu(balanceRub = 0) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📄 Пользовательское соглашение", "tos")],
    [Markup.button.callback("🔒 Политика конфиденциальности", "privacy")],
    [Markup.button.callback("⬅️ Назад", "back")],
  ]);
}

function instructionsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🍎 iPhone (iOS)", "guide_ios")],
    [Markup.button.callback("📱 Android", "guide_android")],
    [Markup.button.callback("📺 Android TV", "guide_android_tv")],
    [Markup.button.callback("💻 Windows", "guide_windows")],
    [Markup.button.callback("🖥️ macOS", "guide_macos")],
    [Markup.button.callback("⬅️ Назад", "back")],
  ]);
}

function promoMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎁 Активировать чужой промокод", "promo_activate")],
    [Markup.button.callback("⬅️ Назад", "back")],
  ]);
}

function mainMenu(balanceRub = 0) {
  return Markup.inlineKeyboard([
    [
      Markup.button.webApp("📱 Открыть приложение", "https://web.grangy.ru/")
    ],
    [
      Markup.button.callback("📦 Мои подписки", "my_subs"),
      Markup.button.callback("💳 Купить подписку", "buy")
    ],
    [
      Markup.button.callback(`💼 Баланс: ${ruMoney(balanceRub)}`, "balance"),
      Markup.button.callback("🎁 Промокод", "promo")
    ],
    [
      Markup.button.callback("📖 Инструкции", "instructions"),
      Markup.button.callback("📋 Информация", "info")
    ],
    [
      Markup.button.url("🛠 Тех.поддержка", "https://t.me/supmaxgroot")
    ],
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

/** Клавиатура для deep link ?start=plan_M1: выбран план — «Приобрести» и «В меню» */
function planSelectedMenu(planKey) {
  const plan = PLANS[planKey];
  if (!plan) return mainMenu(0);
  return Markup.inlineKeyboard([
    [Markup.button.callback(`🛒 Приобрести — ${ruMoney(plan.price)}`, `buy_${planKey}`)],
    [Markup.button.callback("📋 Другие тарифы", "buy")],
    [Markup.button.callback("⬅️ В меню", "back")],
  ]);
}

function balanceMenu(balanceRub = 0) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`💼 Баланс: ${ruMoney(balanceRub)}`, "balance_refresh")],
    [Markup.button.callback("➕ Пополнить", "balance_topup")],
    [Markup.button.callback("🎁 Промокод", "promo")],   // 👈 новая кнопка
    [Markup.button.callback("⬅️ Назад", "back")],
  ]);
}


function topupMenu(requiredAmount = null) {
  const buttons = [];
  
  // Если указана нужная сумма и её нет в стандартных - добавляем кнопку с нужной суммой
  if (requiredAmount && requiredAmount > 0 && !TOPUP_AMOUNTS.includes(requiredAmount)) {
    buttons.push([Markup.button.callback(`💰 Пополнить на ${ruMoney(requiredAmount)}`, `topup_${requiredAmount}`)]);
  }
  
  // Стандартные суммы
  TOPUP_AMOUNTS.forEach(amount => {
    buttons.push([Markup.button.callback(`+ ${ruMoney(amount)}`, `topup_${amount}`)]);
  });
  
  buttons.push([Markup.button.callback("⬅️ Назад", "back")]);
  
  return Markup.inlineKeyboard(buttons);
}

function paymentSuccessMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🚀 Активировать VPN", "buy")],
    [Markup.button.callback("📖 Инструкции по настройке", "instructions")],
  ]);
}

module.exports = {
  PLANS,
  TOPUP_AMOUNTS,
  ruMoney,
  formatDate,
  calcEndDate,
  mainMenu,
  balanceMenu,
  buyMenu,
  topupMenu,
  planSelectedMenu,
  paymentSuccessMenu,
  getDisplayLabel,
  infoMenu,
  instructionsMenu,
  promoMenu,
};
