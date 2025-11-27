// Конфигурация
const TELEGRAM_CHANNEL = 'mgkeit';
const TELEGRAM_CHANNEL_URL = `https://t.me/${TELEGRAM_CHANNEL}`;

// Функция для нормализации даты (приведение к Date объекту)
function parseDate(dateString) {
    if (!dateString) return new Date(0); // Если даты нет, возвращаем старую дату
    
    // Пробуем разные форматы дат
    let date = new Date(dateString);
    
    // Если парсинг не удался, пробуем другие форматы
    if (isNaN(date.getTime())) {
        // Пробуем формат ISO без времени
        date = new Date(dateString + 'T00:00:00');
    }
    
    // Если все еще не удалось, возвращаем текущую дату
    if (isNaN(date.getTime())) {
        date = new Date();
    }
    
    return date;
}

// Функция для форматирования даты
function formatDate(dateString) {
    const date = parseDate(dateString);
    const options = { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    };
    return date.toLocaleDateString('ru-RU', options);
}

// Функция для очистки HTML от Telegram-специфичных элементов
function cleanHtml(html) {
    if (!html) return '';
    
    // Удаляем ссылки на каналы и пользователей
    let cleaned = html.replace(/<a[^>]*class="tgme_widget_message_user"[^>]*>.*?<\/a>/gi, '');
    cleaned = cleaned.replace(/<a[^>]*href="https:\/\/t\.me\/[^"]*"[^>]*>@[^<]*<\/a>/gi, '');
    
    // Оставляем только базовые HTML теги
    cleaned = cleaned.replace(/<br\s*\/?>/gi, '<br>');
    cleaned = cleaned.replace(/<p>/gi, '<p>');
    cleaned = cleaned.replace(/<\/p>/gi, '</p>');
    cleaned = cleaned.replace(/<strong>/gi, '<strong>');
    cleaned = cleaned.replace(/<\/strong>/gi, '</strong>');
    cleaned = cleaned.replace(/<em>/gi, '<em>');
    cleaned = cleaned.replace(/<\/em>/gi, '</em>');
    cleaned = cleaned.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '<a href="$1" target="_blank" rel="noopener noreferrer">$2</a>');
    
    return cleaned;
}

// Функция с таймаутом для fetch
function fetchWithTimeout(url, options = {}, timeout = 5000) {
    return Promise.race([
        fetch(url, options),
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), timeout)
        )
    ]);
}

// Функция для парсинга одного RSS источника
async function fetchSingleRSS(rssUrl) {
    try {
        const response = await fetchWithTimeout(rssUrl, {
            method: 'GET',
            mode: 'cors'
        }, 4000);
        
        if (!response.ok) return null;
        
        const text = await response.text();
        if (!text || text.length < 100) return null;
        
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, 'text/xml');
        
        const parseError = xmlDoc.querySelector('parsererror');
        if (parseError) return null;
        
        const items = xmlDoc.querySelectorAll('item');
        if (items.length === 0) return null;
        
        return Array.from(items).slice(0, 20).map(item => {
            const title = item.querySelector('title')?.textContent || '';
            const description = item.querySelector('description')?.textContent || item.querySelector('content\\:encoded')?.textContent || '';
            const link = item.querySelector('link')?.textContent || '';
            const pubDate = item.querySelector('pubDate')?.textContent || item.querySelector('dc\\:date')?.textContent || '';
            const media = item.querySelector('enclosure')?.getAttribute('url') || '';
            
            let mediaFromDesc = '';
            if (description) {
                const imgMatch = description.match(/<img[^>]+src=["']([^"']+)["']/i);
                if (imgMatch) {
                    mediaFromDesc = imgMatch[1];
                    // Улучшаем качество для Telegram изображений
                    if (mediaFromDesc.includes('cdn.telegram.org')) {
                        mediaFromDesc = mediaFromDesc.split('?')[0];
                    }
                }
            }
            
            // Улучшаем качество основного медиа
            let finalMedia = media || mediaFromDesc;
            if (finalMedia && finalMedia.includes('cdn.telegram.org')) {
                finalMedia = finalMedia.split('?')[0];
            }
            
            return {
                title: title,
                text: cleanHtml(description || title),
                date: pubDate,
                link: link,
                media: finalMedia
            };
        });
    } catch (e) {
        return null;
    }
}

// Функция для парсинга постов через Telegram RSS (параллельно)
async function fetchPostsFromRSS() {
    const rssUrls = [
        `https://t.me/s/${TELEGRAM_CHANNEL}/rss`,
        `https://tg.i-c-a.su/rss/${TELEGRAM_CHANNEL}`,
        `https://rss.app/rss-feed/telegram-channel/${TELEGRAM_CHANNEL}`,
    ];

    // Запускаем все RSS запросы параллельно
    const results = await Promise.allSettled(
        rssUrls.map(url => fetchSingleRSS(url))
    );
    
    // Возвращаем первый успешный результат
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
            return result.value;
        }
    }
    
    return null;
}

// Функция для парсинга одного прокси
async function fetchSingleProxy(proxyUrl) {
    try {
        const response = await fetchWithTimeout(proxyUrl, {
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            mode: 'cors'
        }, 5000);
        
        if (!response.ok) return null;
        
        let html;
        if (proxyUrl.includes('allorigins')) {
            const data = await response.json();
            html = data.contents;
        } else {
            html = await response.text();
        }
        
        if (!html || html.length < 100) return null;
        
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        const messageElements = doc.querySelectorAll('.tgme_widget_message');
        if (messageElements.length === 0) return null;
        
        const posts = [];
        const maxPosts = Math.min(messageElements.length, 20);
        
        for (let i = 0; i < maxPosts; i++) {
            const element = messageElements[i];
            
            const textElement = element.querySelector('.tgme_widget_message_text');
            const text = textElement ? cleanHtml(textElement.innerHTML) : '';
            
            const dateElement = element.querySelector('.tgme_widget_message_date time');
            const date = dateElement?.getAttribute('datetime') || new Date().toISOString();
            
            const linkElement = element.querySelector('.tgme_widget_message_date');
            let link = linkElement?.getAttribute('href') || '';
            if (link && !link.startsWith('http')) {
                link = 'https://t.me' + link;
            }
            if (!link) {
                const postId = element.getAttribute('data-post');
                if (postId) link = `${TELEGRAM_CHANNEL_URL}/${postId}`;
            }
            
            let media = '';
            const mediaElement = element.querySelector('.tgme_widget_message_photo_wrap, .tgme_widget_message_video_wrap');
            if (mediaElement) {
                // Сначала пробуем получить из data-src или src (более качественные версии)
                const img = mediaElement.querySelector('img');
                if (img) {
                    // Пробуем получить оригинальное изображение
                    media = img.getAttribute('data-src') || img.getAttribute('src') || '';
                    // Если это Telegram CDN, убираем параметры размера для получения оригинала
                    if (media && media.includes('cdn.telegram.org')) {
                        media = media.split('?')[0];
                    }
                }
                
                // Если не нашли через img, пробуем из style
                if (!media) {
                    const style = mediaElement.getAttribute('style') || '';
                    const urlMatch = style.match(/url\(['"]?([^'"]+)['"]?\)/);
                    if (urlMatch) {
                        media = urlMatch[1];
                        // Убираем параметры размера для Telegram изображений
                        if (media.includes('cdn.telegram.org')) {
                            media = media.split('?')[0];
                        }
                    }
                }
            }
            
            if (text.trim() || media) {
                posts.push({
                    title: text.substring(0, 100).replace(/<[^>]*>/g, '') + (text.length > 100 ? '...' : ''),
                    text: text,
                    date: date,
                    link: link || TELEGRAM_CHANNEL_URL,
                    media: media
                });
            }
        }
        
        return posts.length > 0 ? posts : null;
    } catch (e) {
        return null;
    }
}

// Функция для парсинга постов через Telegram Web (параллельно)
async function fetchPostsFromTelegramWeb() {
    const proxies = [
        `https://api.allorigins.win/get?url=${encodeURIComponent(`https://t.me/s/${TELEGRAM_CHANNEL}`)}`,
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(`https://t.me/s/${TELEGRAM_CHANNEL}`)}`,
    ];
    
    // Запускаем все прокси параллельно
    const results = await Promise.allSettled(
        proxies.map(url => fetchSingleProxy(url))
    );
    
    // Возвращаем первый успешный результат
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
            return result.value;
        }
    }
    
    return null;
}

// Функция для сортировки постов по дате (свежие сверху)
function sortPostsByDate(posts) {
    return posts.sort((a, b) => {
        const dateA = parseDate(a.date).getTime();
        const dateB = parseDate(b.date).getTime();
        // Сортируем по убыванию (новые сверху)
        return dateB - dateA;
    });
}

// Функция для отображения постов (оптимизированная)
function displayPosts(posts) {
    const container = document.getElementById('posts-container');
    const loading = document.getElementById('loading');
    const errorMessage = document.getElementById('error-message');
    
    if (!posts || posts.length === 0) {
        loading.style.display = 'none';
        errorMessage.style.display = 'block';
        return;
    }
    
    loading.style.display = 'none';
    errorMessage.style.display = 'none';
    
    // Сортируем посты по дате (свежие сверху)
    const sortedPosts = sortPostsByDate([...posts]);
    
    // Используем DocumentFragment для быстрой вставки
    const fragment = document.createDocumentFragment();
    
    sortedPosts.forEach(post => {
        const postElement = document.createElement('div');
        postElement.className = 'blog-post';
        
        let mediaHtml = '';
        if (post.media) {
            // Улучшаем качество изображения для Telegram
            let imageUrl = post.media;
            // Если это Telegram изображение, пробуем получить версию лучшего качества
            if (imageUrl.includes('cdn.telegram.org')) {
                // Убираем параметры размера для получения оригинала
                imageUrl = imageUrl.split('?')[0];
                // Добавляем параметр для лучшего качества
                imageUrl += '?size=large';
            }
            
            mediaHtml = `<div class="post-media">
                <img src="${imageUrl}" alt="Изображение поста" loading="lazy" decoding="async" onerror="this.style.display='none'">
            </div>`;
        }
        
        postElement.innerHTML = `
            ${mediaHtml}
            <div class="post-content">
                <div class="post-text">${post.text || post.title}</div>
                <div class="post-footer">
                    <div class="post-date">${formatDate(post.date)}</div>
                    <a href="${post.link || TELEGRAM_CHANNEL_URL}" target="_blank" rel="noopener noreferrer" class="post-link">
                        Читать в Telegram →
                    </a>
                </div>
            </div>
        `;
        
        fragment.appendChild(postElement);
    });
    
    // Одна операция вставки вместо множества
    container.appendChild(fragment);
}

// Функция для загрузки постов через Telegram Widget (fallback)
function loadTelegramWidget() {
    const container = document.getElementById('posts-container');
    const loading = document.getElementById('loading');
    const errorMessage = document.getElementById('error-message');
    
    loading.style.display = 'none';
    errorMessage.style.display = 'none';
    
    // Показываем сообщение с прямой ссылкой на канал
    container.innerHTML = `
        <div class="widget-wrapper">
            <div class="telegram-fallback">
                <div class="fallback-icon">📱</div>
                <h3 style="color: #FFFFFF; font-size: 24px; margin: 20px 0; text-align: center;">
                    Не удалось загрузить посты автоматически
                </h3>
                <p style="color: rgba(255,255,255,0.8); font-size: 16px; text-align: center; margin-bottom: 30px; line-height: 1.6;">
                    Вы можете посмотреть все посты напрямую в Telegram канале МГКЭИТ.<br>
                    Там вы найдете последние новости, обновления и полезную информацию.
                </p>
                <div style="text-align: center;">
                    <a href="${TELEGRAM_CHANNEL_URL}" target="_blank" rel="noopener noreferrer" class="telegram-link" style="font-size: 16px; padding: 15px 30px;">
                        Открыть канал МГКЭИТ в Telegram →
                    </a>
                </div>
                <div style="text-align: center; margin-top: 20px;">
                    <p style="color: rgba(255,255,255,0.6); font-size: 14px;">
                        Или скопируйте ссылку: <code style="background: rgba(255,255,255,0.1); padding: 4px 8px; border-radius: 4px;">${TELEGRAM_CHANNEL_URL}</code>
                    </p>
                </div>
            </div>
        </div>
    `;
}

// Основная функция загрузки постов (параллельно)
async function loadPosts() {
    const loading = document.getElementById('loading');
    const errorMessage = document.getElementById('error-message');
    
    try {
        // Запускаем RSS и Telegram Web параллельно - берем первый успешный результат
        const [rssResult, webResult] = await Promise.allSettled([
            fetchPostsFromRSS(),
            fetchPostsFromTelegramWeb()
        ]);
        
        // Проверяем результаты
        let posts = null;
        
        if (rssResult.status === 'fulfilled' && rssResult.value && rssResult.value.length > 0) {
            posts = rssResult.value;
        } else if (webResult.status === 'fulfilled' && webResult.value && webResult.value.length > 0) {
            posts = webResult.value;
        }
        
        // Если ничего не загрузилось, показываем fallback
        if (!posts || posts.length === 0) {
            loadTelegramWidget();
            return;
        }
        
        displayPosts(posts);
    } catch (error) {
        console.error('Ошибка при загрузке постов:', error);
        loadTelegramWidget();
    }
}

// Загружаем посты при загрузке страницы
document.addEventListener('DOMContentLoaded', loadPosts);

