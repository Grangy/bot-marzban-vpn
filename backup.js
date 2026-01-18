// backup.js - Система бэкапов с поддержкой Яндекс.Диска
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BACKUP_DIR = process.env.BACKUP_DIR || './back';
const DB_PATH = './prisma/dev.db';
const MAX_BACKUPS = 10;
const BACKUP_COOLDOWN = 60 * 60 * 1000; // 1 час в миллисекундах
const LAST_BACKUP_FILE = path.join(BACKUP_DIR, '.last_backup');

// Яндекс.Диск настройки (из .env)
const CLIENT_ID = process.env.YANDEX_CLIENT_ID;
const CLIENT_SECRET = process.env.YANDEX_CLIENT_SECRET;
const TOKEN_FILE = path.join(__dirname, 'token.json');
const YANDEX_BACKUP_FOLDER = 'backup_bot_tg';

/**
 * Загрузка токенов Яндекс.Диска
 */
function loadYandexTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    }
  } catch (err) {
    console.log('⚠️ Не удалось загрузить токен Яндекс.Диска');
  }
  return null;
}

/**
 * Сохранение токенов Яндекс.Диска
 */
function saveYandexTokens(accessToken, refreshToken, expiresIn) {
  const tokenData = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Date.now() + (expiresIn * 1000)
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

/**
 * Обновление токена через refresh_token
 */
async function refreshYandexToken(refreshToken) {
  try {
    console.log('🔄 Обновляю токен Яндекс.Диска...');
    const response = await axios.post('https://oauth.yandex.ru/token', 
      `grant_type=refresh_token&refresh_token=${refreshToken}&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    
    const newAccessToken = response.data.access_token;
    const newRefreshToken = response.data.refresh_token || refreshToken;
    const expiresIn = response.data.expires_in || 31536000;
    
    saveYandexTokens(newAccessToken, newRefreshToken, expiresIn);
    console.log('✅ Токен Яндекс.Диска обновлен');
    
    return newAccessToken;
  } catch (err) {
    console.error('❌ Ошибка обновления токена Яндекс.Диска:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Получение валидного токена Яндекс.Диска
 */
async function getYandexToken() {
  const tokenData = loadYandexTokens();
  
  if (!tokenData) {
    console.log('⚠️ Токен Яндекс.Диска не найден. Запустите node yandex.js для авторизации.');
    return null;
  }
  
  // Проверяем, не истек ли токен (с запасом 5 минут)
  if (tokenData.expires_at > Date.now() + 5 * 60 * 1000) {
    return tokenData.access_token;
  }
  
  // Пробуем обновить токен
  if (tokenData.refresh_token) {
    return await refreshYandexToken(tokenData.refresh_token);
  }
  
  console.log('⚠️ Токен Яндекс.Диска истек. Запустите node yandex.js для авторизации.');
  return null;
}

/**
 * Создание папки на Яндекс.Диске
 */
async function ensureYandexFolder(token, folderPath) {
  try {
    await axios.put('https://cloud-api.yandex.net/v1/disk/resources', null, {
      params: { path: folderPath },
      headers: { Authorization: `OAuth ${token}` }
    });
  } catch (err) {
    // Папка уже существует - это нормально
    if (err.response?.status !== 409) {
      throw err;
    }
  }
}

/**
 * Загрузка файла на Яндекс.Диск
 */
async function uploadToYandexDisk(localPath, remotePath) {
  try {
    const token = await getYandexToken();
    if (!token) {
      console.log('⚠️ Пропускаю загрузку на Яндекс.Диск (нет токена)');
      return { success: false, error: 'No token' };
    }

    // Создаем папку если нужно
    await ensureYandexFolder(token, YANDEX_BACKUP_FOLDER);

    // Получаем ссылку для загрузки
    const uploadUrlResp = await axios.get('https://cloud-api.yandex.net/v1/disk/resources/upload', {
      params: { path: `${YANDEX_BACKUP_FOLDER}/${remotePath}`, overwrite: true },
      headers: { Authorization: `OAuth ${token}` }
    });
    const uploadUrl = uploadUrlResp.data.href;

    // Загружаем файл
    const fileStream = fs.createReadStream(localPath);
    const stats = fs.statSync(localPath);
    
    await axios.put(uploadUrl, fileStream, {
      headers: { 
        'Content-Type': 'application/octet-stream',
        'Content-Length': stats.size
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    console.log(`☁️  Бэкап загружен на Яндекс.Диск: ${remotePath}`);
    return { success: true };
  } catch (err) {
    console.error('❌ Ошибка загрузки на Яндекс.Диск:', err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Очистка старых бэкапов на Яндекс.Диске
 */
async function cleanupYandexBackups() {
  try {
    const token = await getYandexToken();
    if (!token) return;

    // Получаем список файлов
    const response = await axios.get('https://cloud-api.yandex.net/v1/disk/resources', {
      params: { path: YANDEX_BACKUP_FOLDER, limit: 100 },
      headers: { Authorization: `OAuth ${token}` }
    });

    const items = response.data._embedded?.items || [];
    const backups = items
      .filter(item => item.name.startsWith('backup-') && item.name.endsWith('.db'))
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));

    // Удаляем лишние бэкапы
    if (backups.length > MAX_BACKUPS) {
      const toDelete = backups.slice(MAX_BACKUPS);
      for (const backup of toDelete) {
        await axios.delete('https://cloud-api.yandex.net/v1/disk/resources', {
          params: { path: `${YANDEX_BACKUP_FOLDER}/${backup.name}`, permanently: true },
          headers: { Authorization: `OAuth ${token}` }
        });
        console.log(`☁️  Удален старый бэкап с Яндекс.Диска: ${backup.name}`);
      }
    }
  } catch (err) {
    console.error('⚠️ Ошибка очистки бэкапов на Яндекс.Диске:', err.response?.data || err.message);
  }
}

/**
 * Проверяет, прошло ли достаточно времени с последнего бэкапа
 */
function canCreateBackup() {
  try {
    if (!fs.existsSync(LAST_BACKUP_FILE)) {
      return true;
    }
    
    const lastBackupTime = parseInt(fs.readFileSync(LAST_BACKUP_FILE, 'utf8'), 10);
    const timeSinceLastBackup = Date.now() - lastBackupTime;
    
    if (timeSinceLastBackup < BACKUP_COOLDOWN) {
      const minutesLeft = Math.ceil((BACKUP_COOLDOWN - timeSinceLastBackup) / 60000);
      console.log(`⏳ Бэкап был создан недавно. Следующий возможен через ${minutesLeft} мин.`);
      return false;
    }
    
    return true;
  } catch (err) {
    return true;
  }
}

/**
 * Обновляет время последнего бэкапа
 */
function updateLastBackupTime() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    fs.writeFileSync(LAST_BACKUP_FILE, Date.now().toString());
  } catch (err) {
    console.error('⚠️ Не удалось обновить время последнего бэкапа:', err.message);
  }
}

/**
 * Создает бэкап базы данных (локально + Яндекс.Диск)
 * @param {boolean} force - принудительно создать бэкап, игнорируя cooldown
 */
async function createBackup(force = false) {
  try {
    // Проверяем cooldown (если не принудительный бэкап)
    if (!force && !canCreateBackup()) {
      return { success: false, error: 'Cooldown active', skipped: true };
    }

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

    console.log(`✅ Локальный бэкап создан: ${backupFileName} (${fileSizeKB} KB)`);

    // Обновляем время последнего бэкапа
    updateLastBackupTime();

    // Загружаем на Яндекс.Диск
    await uploadToYandexDisk(backupPath, backupFileName);

    // Очищаем старые бэкапы (локально и на Яндекс.Диске)
    await cleanupOldBackups();
    await cleanupYandexBackups();

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
 * Очищает старые локальные бэкапы, оставляя только последние MAX_BACKUPS
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
      .sort((a, b) => b.mtime - a.mtime);

    // Удаляем лишние файлы
    if (files.length > MAX_BACKUPS) {
      const filesToDelete = files.slice(MAX_BACKUPS);
      
      for (const file of filesToDelete) {
        fs.unlinkSync(file.path);
        console.log(`🗑️ Удален старый локальный бэкап: ${file.name}`);
      }
    }

    console.log(`📊 Локальных бэкапов: ${Math.min(files.length, MAX_BACKUPS)}/${MAX_BACKUPS}`);

  } catch (error) {
    console.error('❌ Ошибка при очистке старых бэкапов:', error);
  }
}

/**
 * Получает список всех локальных бэкапов
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
    
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, currentBackupPath);
    }

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
  
  // Бэкап каждые 12 часов
  const interval = 12 * 60 * 60 * 1000;
  
  // Создаем первый бэкап при запуске (с проверкой cooldown)
  createBackup(false).then(result => {
    if (result.skipped) {
      console.log('📦 Бэкап при запуске пропущен (cooldown)');
    }
  });
  
  // Устанавливаем интервал для периодических бэкапов
  setInterval(async () => {
    console.log('⏰ Время для создания бэкапа...');
    await createBackup(true); // Принудительный бэкап по расписанию
  }, interval);
  
  console.log(`📅 Бэкапы: каждые 12 часов + при запуске (если прошел 1 час)`);
  console.log(`☁️  Яндекс.Диск: ${loadYandexTokens() ? 'подключен' : 'не настроен (запустите node yandex.js)'}`);
}

module.exports = {
  createBackup,
  cleanupOldBackups,
  getBackupList,
  restoreBackup,
  startBackupScheduler,
  uploadToYandexDisk,
  getYandexToken
};
