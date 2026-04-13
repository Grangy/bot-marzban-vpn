const { hasActiveYearRenewalDiscount } = require("./menus");

/**
 * Подставляет yearRenewalDiscountEndsAt с любой строки User с тем же telegramId,
 * если у текущей строки (ЛС / группа) поле пустое, а акция уже выдана.
 */
async function withMergedYearRenewalDiscount(prisma, user) {
  if (!user || user.telegramId == null) return user;
  if (hasActiveYearRenewalDiscount(user)) return user;
  const now = new Date();
  const donor = await prisma.user.findFirst({
    where: {
      telegramId: String(user.telegramId),
      yearRenewalDiscountEndsAt: { gt: now },
    },
    select: { yearRenewalDiscountEndsAt: true },
    orderBy: { yearRenewalDiscountEndsAt: "desc" },
  });
  if (!donor?.yearRenewalDiscountEndsAt) return user;
  return { ...user, yearRenewalDiscountEndsAt: donor.yearRenewalDiscountEndsAt };
}

module.exports = { withMergedYearRenewalDiscount };
