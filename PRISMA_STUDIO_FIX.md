# Prisma Studio: если не открывается (MODULE_NOT_FOUND, белый экран)

## Что попробовать

1. **Чистый запуск** (часто помогает):
   ```bash
   npm run studio:fix
   ```

2. **Обычный запуск**:
   ```bash
   npm run studio
   ```

3. **Сброс npx-кэша**:
   ```bash
   npx clear-npx-cache
   npm run studio
   ```

4. **Полная переустановка**:
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   npx prisma generate
   npm run studio
   ```

5. **Альтернатива** — DB Browser for SQLite:
   - Установить [DB Browser for SQLite](https://sqlitebrowser.org/)
   - Открыть файл `prisma/dev.db`
