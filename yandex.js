require('dotenv').config();
const axios = require('axios');
const readline = require('readline-sync');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');

// Яндекс.Диск настройки (из .env)
const CLIENT_ID = process.env.YANDEX_CLIENT_ID;
const CLIENT_SECRET = process.env.YANDEX_CLIENT_SECRET;
const REDIRECT_URI = 'https://oauth.yandex.ru/verification_code';
const TOKEN_FILE = path.join(__dirname, 'token.json');

// Функция для сохранения токена
function saveToken(accessToken, refreshToken, expiresIn) {
    const tokenData = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: Date.now() + (expiresIn * 1000) // expiresIn в секундах
    };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
    console.log('Токен сохранен в token.json');
}

// Функция для загрузки токенов из файла
function loadTokens() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        }
    } catch (err) {
        console.log('Не удалось загрузить токен из файла');
    }
    return null;
}

// Функция для обновления токена через refresh_token
async function refreshAccessToken(refreshToken) {
    try {
        console.log('Обновляю токен через refresh_token...');
        const response = await axios.post('https://oauth.yandex.ru/token', {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET
        }, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        
        const newAccessToken = response.data.access_token;
        const newRefreshToken = response.data.refresh_token || refreshToken; // Новый refresh_token или старый
        const expiresIn = response.data.expires_in || 31536000;
        
        // Сохраняем обновленные токены
        saveToken(newAccessToken, newRefreshToken, expiresIn);
        console.log('Токен успешно обновлен!');
        
        return newAccessToken;
    } catch (err) {
        console.error('Ошибка обновления токена:', err.response?.data || err.message);
        return null;
    }
}

// 3️⃣ Получить access_token
async function getToken() {
    // Сначала проверяем сохраненные токены
    const tokenData = loadTokens();
    
    if (tokenData) {
        // Проверяем, не истек ли access_token (оставляем запас в 5 минут)
        if (tokenData.expires_at > Date.now() + 5 * 60 * 1000) {
            console.log('Используется сохраненный токен');
            return tokenData.access_token;
        } else if (tokenData.refresh_token) {
            // Если access_token истек, но есть refresh_token - обновляем токен
            const newToken = await refreshAccessToken(tokenData.refresh_token);
            if (newToken) {
                return newToken;
            }
            console.log('Не удалось обновить токен, требуется новая авторизация');
        } else {
            console.log('Сохраненный токен истек и нет refresh_token, требуется новая авторизация');
        }
    }

    // Если токена нет или не удалось обновить, запрашиваем новый
    console.log('Перейдите по этой ссылке и скопируйте код:');
    console.log(`https://oauth.yandex.ru/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}`);
    
    const code = readline.question('Введите код подтверждения: ');

    try {
        // Параметры должны быть в теле запроса, а не в query
        const response = await axios.post('https://oauth.yandex.ru/token', {
            grant_type: 'authorization_code',
            code: code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI
        }, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        
        const accessToken = response.data.access_token;
        const refreshToken = response.data.refresh_token; // refresh_token для долгосрочного доступа
        const expiresIn = response.data.expires_in || 31536000; // По умолчанию 1 год
        
        // Сохраняем токены (включая refresh_token для долгосрочного использования)
        saveToken(accessToken, refreshToken, expiresIn);
        
        if (refreshToken) {
            console.log('Токен сохранен с refresh_token для долгосрочного доступа!');
        }
        
        return accessToken;
    } catch (err) {
        console.error('Ошибка получения токена:', err.response?.data || err.message);
        return null;
    }
}

// Функция для создания папки на Яндекс.Диске
async function ensureFolder(token, folderPath) {
    try {
        await axios.put('https://cloud-api.yandex.net/v1/disk/resources', null, {
            params: { path: folderPath },
            headers: { Authorization: `OAuth ${token}` }
        });
        console.log(`Папка "${folderPath}" создана или уже существует`);
    } catch (err) {
        // Если папка уже существует, это нормально
        if (err.response?.status === 409) {
            console.log(`Папка "${folderPath}" уже существует`);
        } else {
            console.error('Ошибка создания папки:', err.response?.data || err.message);
            throw err;
        }
    }
}

// 4️⃣ Загрузить файл на Яндекс.Диск
async function uploadFile(token) {
    try {
        // Сначала убеждаемся, что папка backup_bot_tg существует
        await ensureFolder(token, 'backup_bot_tg');

        // Получаем ссылку для загрузки
        const uploadUrlResp = await axios.get('https://cloud-api.yandex.net/v1/disk/resources/upload', {
            params: { path: 'backup_bot_tg/test.txt', overwrite: true },
            headers: { Authorization: `OAuth ${token}` }
        });
        const uploadUrl = uploadUrlResp.data.href;

        // Загружаем файл
        const form = new FormData();
        form.append('file', fs.createReadStream('test.txt'));

        await axios.put(uploadUrl, fs.createReadStream('test.txt'), {
            headers: { 'Content-Type': 'application/octet-stream' }
        });

        console.log('Файл успешно загружен!');
    } catch (err) {
        console.error('Ошибка загрузки файла:', err.response?.data || err.message);
    }
}

(async () => {
    const token = await getToken();
    if (token) await uploadFile(token);
})();

