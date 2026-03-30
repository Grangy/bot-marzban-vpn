-- UUID пользователя в Remnawave (нужен для PATCH /v1/users/:uuid/extend; lookup по username на API может быть недоступен)
ALTER TABLE "Subscription" ADD COLUMN "remnawaveUuid" TEXT;
