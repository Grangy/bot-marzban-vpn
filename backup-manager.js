#!/usr/bin/env node
// backup-manager.js - Управление бэкапами (локальными и Яндекс.Диск)
require('dotenv').config();
const { createBackup, getBackupList, restoreBackup, cleanupOldBackups, getYandexToken, uploadToYandexDisk } = require('./backup');

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'create':
      console.log('📦 Создание бэкапа...');
      const result = await createBackup(true); // force=true для ручного запуска
      if (result.success) {
        console.log(`✅ Бэкап создан: ${result.filename} (${result.size} KB)`);
      } else if (result.skipped) {
        console.log(`⏳ Бэкап пропущен (cooldown активен)`);
      } else {
        console.log(`❌ Ошибка: ${result.error}`);
      }
      break;

    case 'list':
      console.log('📋 Список локальных бэкапов:');
      const backups = getBackupList();
      if (backups.length === 0) {
        console.log('  Нет бэкапов');
      } else {
        backups.forEach((backup, index) => {
          console.log(`  ${index + 1}. ${backup.name} (${backup.size} KB) - ${backup.created.toLocaleString()}`);
        });
      }
      break;

    case 'restore':
      const backupName = process.argv[3];
      if (!backupName) {
        console.log('❌ Укажите имя бэкапа для восстановления');
        console.log('Использование: node backup-manager.js restore <backup-name>');
        process.exit(1);
      }
      console.log(`🔄 Восстановление из бэкапа: ${backupName}`);
      const restoreResult = await restoreBackup(backupName);
      if (restoreResult.success) {
        console.log(`✅ База данных восстановлена из: ${backupName}`);
        console.log(`💾 Текущая БД сохранена как: ${restoreResult.currentBackup}`);
      } else {
        console.log(`❌ Ошибка восстановления: ${restoreResult.error}`);
      }
      break;

    case 'cleanup':
      console.log('🧹 Очистка старых бэкапов...');
      await cleanupOldBackups();
      console.log('✅ Очистка завершена');
      break;

    case 'status':
      const statusBackups = getBackupList();
      const yandexToken = await getYandexToken();
      
      console.log(`📊 Статус бэкапов:`);
      console.log(`  Локальных бэкапов: ${statusBackups.length}`);
      console.log(`  Максимум: 10`);
      console.log(`  Директория: ${process.env.BACKUP_DIR || './back'}`);
      console.log(`  Яндекс.Диск: ${yandexToken ? '✅ подключен' : '❌ не настроен'}`);
      
      if (statusBackups.length > 0) {
        const latest = statusBackups[0];
        console.log(`  Последний: ${latest.name} (${latest.created.toLocaleString()})`);
      }
      break;

    case 'upload':
      const uploadFile = process.argv[3];
      if (!uploadFile) {
        console.log('❌ Укажите имя файла для загрузки');
        console.log('Использование: node backup-manager.js upload <backup-name>');
        process.exit(1);
      }
      
      const backupList = getBackupList();
      const backupToUpload = backupList.find(b => b.name === uploadFile);
      
      if (!backupToUpload) {
        console.log(`❌ Бэкап не найден: ${uploadFile}`);
        process.exit(1);
      }
      
      console.log(`☁️  Загрузка на Яндекс.Диск: ${uploadFile}`);
      const uploadResult = await uploadToYandexDisk(backupToUpload.path, uploadFile);
      if (uploadResult.success) {
        console.log(`✅ Файл загружен на Яндекс.Диск`);
      } else {
        console.log(`❌ Ошибка загрузки: ${uploadResult.error}`);
      }
      break;

    case 'yandex-auth':
      console.log('🔐 Проверка авторизации Яндекс.Диска...');
      const token = await getYandexToken();
      if (token) {
        console.log('✅ Авторизация активна');
      } else {
        console.log('❌ Требуется авторизация. Запустите: node yandex.js');
      }
      break;

    default:
      console.log('🔧 Управление бэкапами базы данных');
      console.log('');
      console.log('Использование:');
      console.log('  node backup-manager.js create      - Создать бэкап (локально + Яндекс.Диск)');
      console.log('  node backup-manager.js list        - Показать список локальных бэкапов');
      console.log('  node backup-manager.js restore <name> - Восстановить из бэкапа');
      console.log('  node backup-manager.js cleanup     - Очистить старые бэкапы');
      console.log('  node backup-manager.js status      - Показать статус');
      console.log('  node backup-manager.js upload <name> - Загрузить бэкап на Яндекс.Диск');
      console.log('  node backup-manager.js yandex-auth - Проверить авторизацию Яндекс.Диска');
      console.log('');
      console.log('Примеры:');
      console.log('  node backup-manager.js create');
      console.log('  node backup-manager.js list');
      console.log('  node backup-manager.js restore backup-2025-10-21T09-25-22-811Z.db');
      console.log('');
      console.log('Настройка Яндекс.Диска:');
      console.log('  1. Запустите: node yandex.js');
      console.log('  2. Перейдите по ссылке и введите код');
      console.log('  3. Токен сохранится в token.json');
      break;
  }
}

main().catch(console.error);
