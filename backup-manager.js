#!/usr/bin/env node
// backup-manager.js - Управление бэкапами
require('dotenv').config();
const { createBackup, getBackupList, restoreBackup, cleanupOldBackups } = require('./backup');

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'create':
      console.log('📦 Создание бэкапа...');
      const result = await createBackup();
      if (result.success) {
        console.log(`✅ Бэкап создан: ${result.filename} (${result.size} KB)`);
      } else {
        console.log(`❌ Ошибка: ${result.error}`);
      }
      break;

    case 'list':
      console.log('📋 Список бэкапов:');
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
      console.log(`📊 Статус бэкапов:`);
      console.log(`  Всего бэкапов: ${statusBackups.length}`);
      console.log(`  Максимум: 10`);
      console.log(`  Директория: ${process.env.BACKUP_DIR || './back'}`);
      if (statusBackups.length > 0) {
        const latest = statusBackups[0];
        console.log(`  Последний: ${latest.name} (${latest.created.toLocaleString()})`);
      }
      break;

    default:
      console.log('🔧 Управление бэкапами базы данных');
      console.log('');
      console.log('Использование:');
      console.log('  node backup-manager.js create     - Создать бэкап');
      console.log('  node backup-manager.js list       - Показать список бэкапов');
      console.log('  node backup-manager.js restore <name> - Восстановить из бэкапа');
      console.log('  node backup-manager.js cleanup    - Очистить старые бэкапы');
      console.log('  node backup-manager.js status    - Показать статус');
      console.log('');
      console.log('Примеры:');
      console.log('  node backup-manager.js create');
      console.log('  node backup-manager.js list');
      console.log('  node backup-manager.js restore backup-2025-10-21T09-25-22-811Z.db');
      break;
  }
}

main().catch(console.error);
