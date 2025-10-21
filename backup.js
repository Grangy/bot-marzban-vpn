// backup.js
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const BACKUP_DIR = process.env.BACKUP_DIR || './back';
const DB_PATH = './prisma/dev.db';
const MAX_BACKUPS = 10;

/**
 * Создает бэкап базы данных
 */
async function createBackup() {
  try {
    // Проверяем существование директории бэкапа
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      console.log(`📁 Создана директория бэкапа: ${BACKUP_DIR}`);
    }

    // Проверяем существование базы данных
    if (!fs.existsSync(DB_PATH)) {
      console.warn('⚠️ База данных не найдена:', DB_PATH);
      return { success: false, error: 'Database not found' };
    }

    // Генерируем имя файла с timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `backup-${timestamp}.db`;
    const backupPath = path.join(BACKUP_DIR, backupFileName);

    // Копируем файл базы данных
    fs.copyFileSync(DB_PATH, backupPath);
    
    // Получаем размер файла
    const stats = fs.statSync(backupPath);
    const fileSizeKB = Math.round(stats.size / 1024);

    console.log(`✅ Бэкап создан: ${backupFileName} (${fileSizeKB} KB)`);

    // Очищаем старые бэкапы
    await cleanupOldBackups();

    return { 
      success: true, 
      filename: backupFileName, 
      size: fileSizeKB,
      path: backupPath 
    };

  } catch (error) {
    console.error('❌ Ошибка при создании бэкапа:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Очищает старые бэкапы, оставляя только последние MAX_BACKUPS
 */
async function cleanupOldBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      return;
    }

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(file => file.startsWith('backup-') && file.endsWith('.db'))
      .map(file => {
        const filePath = path.join(BACKUP_DIR, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          path: filePath,
          mtime: stats.mtime
        };
      })
      .sort((a, b) => b.mtime - a.mtime); // Сортируем по дате (новые первые)

    // Удаляем лишние файлы
    if (files.length > MAX_BACKUPS) {
      const filesToDelete = files.slice(MAX_BACKUPS);
      
      for (const file of filesToDelete) {
        fs.unlinkSync(file.path);
        console.log(`🗑️ Удален старый бэкап: ${file.name}`);
      }
      
      console.log(`🧹 Очищено ${filesToDelete.length} старых бэкапов`);
    }

    console.log(`📊 Всего бэкапов: ${files.length}/${MAX_BACKUPS}`);

  } catch (error) {
    console.error('❌ Ошибка при очистке старых бэкапов:', error);
  }
}

/**
 * Получает список всех бэкапов
 */
function getBackupList() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      return [];
    }

    return fs.readdirSync(BACKUP_DIR)
      .filter(file => file.startsWith('backup-') && file.endsWith('.db'))
      .map(file => {
        const filePath = path.join(BACKUP_DIR, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          size: Math.round(stats.size / 1024),
          created: stats.mtime,
          path: filePath
        };
      })
      .sort((a, b) => b.created - a.created);
  } catch (error) {
    console.error('❌ Ошибка при получении списка бэкапов:', error);
    return [];
  }
}

/**
 * Восстанавливает базу данных из бэкапа
 */
async function restoreBackup(backupFileName) {
  try {
    const backupPath = path.join(BACKUP_DIR, backupFileName);
    
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Бэкап не найден: ${backupFileName}`);
    }

    // Создаем бэкап текущей БД перед восстановлением
    const currentBackup = `restore-backup-${Date.now()}.db`;
    const currentBackupPath = path.join(BACKUP_DIR, currentBackup);
    fs.copyFileSync(DB_PATH, currentBackupPath);

    // Восстанавливаем из бэкапа
    fs.copyFileSync(backupPath, DB_PATH);
    
    console.log(`✅ База данных восстановлена из: ${backupFileName}`);
    console.log(`💾 Текущая БД сохранена как: ${currentBackup}`);
    
    return { success: true, currentBackup };

  } catch (error) {
    console.error('❌ Ошибка при восстановлении бэкапа:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Запускает автоматический бэкап по расписанию
 */
function startBackupScheduler() {
  console.log('🕐 Запуск планировщика бэкапов...');
  
  // Бэкап каждые 12 часов (2 раза в день)
  const interval = 12 * 60 * 60 * 1000; // 12 часов в миллисекундах
  
  // Создаем первый бэкап сразу
  createBackup();
  
  // Устанавливаем интервал
  setInterval(async () => {
    console.log('⏰ Время для создания бэкапа...');
    await createBackup();
  }, interval);
  
  console.log(`📅 Бэкапы будут создаваться каждые 12 часов`);
}

module.exports = {
  createBackup,
  cleanupOldBackups,
  getBackupList,
  restoreBackup,
  startBackupScheduler
};
