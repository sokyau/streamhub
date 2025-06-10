let currentVideoId = null;
let platforms = [];
let videos = [];
let activeDownloadId = null;
let ws = null;
let wsReconnectInterval = null;

document.addEventListener('DOMContentLoaded', () => {
    initializeWebSocket();
    loadVideos();
    loadPlatforms();
    setupEventListeners();
    checkDropboxAPIStatus();
    setInterval(updateStreamStatus, 5000);
});

function initializeWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('WebSocket connected');
        if (wsReconnectInterval) {
            clearInterval(wsReconnectInterval);
            wsReconnectInterval = null;
        }
    };
    
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
    };
    
    ws.onclose = () => {
        console.log('WebSocket disconnected, reconnecting...');
        if (!wsReconnectInterval) {
            wsReconnectInterval = setInterval(() => {
                if (ws.readyState === WebSocket.CLOSED) {
                    initializeWebSocket();
                }
            }, 3000);
        }
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

function handleWebSocketMessage(message) {
    const { type, data } = message;
    
    switch (type) {
        case 'download_progress':
            updateDownloadProgress(data);
            break;
            
        case 'download_complete':
            handleDownloadComplete(data);
            break;
            
        case 'download_error':
            handleDownloadError(data);
            break;
            
        case 'stream_ended':
            updateStreamStatus();
            break;
            
        case 'stream_crashed':
            handleStreamCrash(data);
            break;
            
        case 'loop_iteration':
            updateLoopIndicator(data);
            break;
            
        default:
            break;
    }
}

function handleStreamCrash(data) {
    showNotification('error', 'Stream Detenido', `El stream se detuvo inesperadamente`);
    updateStreamStatus();
}

function updateLoopIndicator(data) {
    const streamElement = document.querySelector(`[data-stream-key="${data.videoId}-${data.platformId}"]`);
    if (streamElement) {
        const indicator = streamElement.querySelector('.loop-iteration');
        if (indicator) {
            indicator.textContent = `Iteración ${data.iteration}`;
        }
    }
}

function setupEventListeners() {
    document.getElementById('platformForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await savePlatform();
    });
    
    document.getElementById('scheduleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveSchedule();
    });
    
    document.getElementById('dropboxAPIForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveDropboxAPI();
    });
    
    document.querySelectorAll('.day-checkbox').forEach(label => {
        const checkbox = label.querySelector('input');
        label.onclick = () => {
            checkbox.checked = !checkbox.checked;
            label.classList.toggle('selected', checkbox.checked);
        };
    });
}

async function startDropboxDownload() {
    const url = document.getElementById('dropboxUrl').value.trim();
    
    if (!url) {
        showNotification('error', 'Error', 'Por favor ingresa una URL de Dropbox');
        return;
    }
    
    if (!url.includes('dropbox.com')) {
        showNotification('error', 'Error', 'Por favor ingresa una URL válida de Dropbox');
        return;
    }
    
    try {
        const response = await fetch('/api/dropbox/download-url', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Error al iniciar descarga');
        }
        
        const result = await response.json();
        activeDownloadId = result.downloadId;
        
        closeModal('dropboxModal');
        showModal('downloadProgressModal');
        
        document.getElementById('downloadsSection').style.display = 'block';
        
    } catch (error) {
        showNotification('error', 'Error', error.message);
    }
}

function updateDownloadProgress(data) {
    if (data.downloadId !== activeDownloadId) return;
    
    const progressFill = document.getElementById('downloadProgressFill');
    const progressText = document.getElementById('downloadProgress');
    const speedText = document.getElementById('downloadSpeed');
    const sizeText = document.getElementById('downloadSize');
    const statusText = document.getElementById('downloadStatus');
    
    progressFill.style.width = `${data.progress}%`;
    progressText.textContent = `${data.progress}%`;
    speedText.textContent = data.speed || '--';
    sizeText.textContent = formatFileSize(data.downloadedBytes) + ' / ' + formatFileSize(data.totalBytes);
    statusText.textContent = 'Descargando...';
}

function handleDownloadComplete(data) {
    if (data.downloadId === activeDownloadId) {
        closeModal('downloadProgressModal');
        showNotification('success', 'Descarga Completa', `${data.filename} se ha descargado correctamente`);
        loadVideos();
        activeDownloadId = null;
        
        checkActiveDownloads();
    }
}

function handleDownloadError(data) {
    if (data.downloadId === activeDownloadId) {
        closeModal('downloadProgressModal');
        showNotification('error', 'Error en Descarga', data.error);
        activeDownloadId = null;
        checkActiveDownloads();
    }
}

async function cancelDownload() {
    if (!activeDownloadId) return;
    
    try {
        await fetch(`/api/dropbox/download/${activeDownloadId}/cancel`, {
            method: 'POST'
        });
        
        closeModal('downloadProgressModal');
        showNotification('info', 'Descarga Cancelada', 'La descarga ha sido cancelada');
        activeDownloadId = null;
        checkActiveDownloads();
        
    } catch (error) {
        showNotification('error', 'Error', 'No se pudo cancelar la descarga');
    }
}

async function checkActiveDownloads() {
    if (!activeDownloadId) {
        document.getElementById('downloadsSection').style.display = 'none';
    }
}

async function checkDropboxAPIStatus() {
    try {
        const response = await fetch('/api/dropbox/api-status');
        const status = await response.json();
        
        const statusDiv = document.getElementById('dropboxAPIStatus');
        if (status.configured) {
            statusDiv.innerHTML = `
                <div class="status-indicator success">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                        <path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2"/>
                    </svg>
                    API Configurada
                </div>
            `;
        } else {
            statusDiv.innerHTML = `
                <div class="status-indicator warning">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                        <path d="M12 9V13M12 17H12.01M12 3L2 20H22L12 3Z" stroke="currentColor" stroke-width="2"/>
                    </svg>
                    API No Configurada
                </div>
            `;
        }
    } catch (error) {
        console.error('Error checking Dropbox API status:', error);
    }
}

async function saveDropboxAPI() {
    const accessToken = document.getElementById('dropboxAccessToken').value.trim();
    const refreshToken = document.getElementById('dropboxRefreshToken').value.trim();
    
    if (!accessToken) {
        showNotification('error', 'Error', 'Access token es requerido');
        return;
    }
    
    try {
        const response = await fetch('/api/dropbox/setup-api', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ accessToken, refreshToken })
        });
        
        if (!response.ok) {
            throw new Error('Error al configurar API');
        }
        
        showNotification('success', 'API Configurada', 'La API de Dropbox se configuró correctamente');
        closeModal('settingsModal');
        checkDropboxAPIStatus();
        
    } catch (error) {
        showNotification('error', 'Error', error.message);
    }
}

async function loadVideos() {
    try {
        const response = await fetch('/api/videos');
        videos = await response.json();
        renderVideos();
    } catch (error) {
        console.error('Error loading videos:', error);
    }
}

function renderVideos() {
    const container = document.getElementById('videosList');
    
    if (videos.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none">
                    <path d="M15 10L19.5528 7.72361C20.2177 7.39116 21 7.87465 21 8.61803V15.382C21 16.1253 20.2177 16.6088 19.5528 16.2764L15 14M5 18H13C14.1046 18 15 17.1046 15 16V8C15 6.89543 14.1046 6 13 6H5C3.89543 6 3 6.89543 3 8V16C3 17.1046 3.89543 18 5 18Z" stroke="currentColor" stroke-width="2"/>
                </svg>
                <p>No hay videos disponibles</p>
                <p>Importa videos desde Dropbox para comenzar</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = videos.map(video => {
        const sourceIcon = video.source === 'dropbox' ? 
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 7L12 12L22 7L12 2Z"/><path d="M2 17L12 22L22 17L12 12L2 17Z" opacity="0.6"/></svg>' : 
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 7L12 12L22 7L12 2Z"/></svg>';
            
        return `
            <div class="video-card">
                <div class="video-info">
                    <h3 class="video-name">
                        ${sourceIcon}
                        ${escapeHtml(video.original_name)}
                    </h3>
                    <p class="video-meta">
                        ${formatFileSize(video.size)} • ${formatDate(video.uploaded_at)}
                    </p>
                </div>
                <div class="video-actions">
                    <button class="btn btn-primary btn-sm" onclick="showStreamModal(${video.id}, '${escapeHtml(video.original_name)}')">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                            <path d="M8 5V19L19 12L8 5Z" fill="currentColor"/>
                        </svg>
                        Transmitir
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="deleteVideo(${video.id})">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                            <path d="M19 7L18.1327 19.1425C18.0579 20.1891 17.187 21 16.1378 21H7.86224C6.81296 21 5.94208 20.1891 5.86732 19.1425L5 7M10 11V17M14 11V17M15 7V4C15 3.44772 14.5523 3 14 3H10C9.44772 3 9 3.44772 9 4V7M4 7H20" stroke="currentColor" stroke-width="2"/>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function deleteVideo(videoId) {
    if (!confirm('¿Estás seguro de eliminar este video?')) return;
    
    try {
        const response = await fetch(`/api/videos/${videoId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            loadVideos();
            showNotification('success', 'Video Eliminado', 'El video se eliminó correctamente');
        } else {
            showNotification('error', 'Error', 'No se pudo eliminar el video');
        }
    } catch (error) {
        showNotification('error', 'Error', 'Error al eliminar el video');
    }
}

async function loadPlatforms() {
    try {
        const response = await fetch('/api/platforms');
        platforms = await response.json();
    } catch (error) {
        console.error('Error loading platforms:', error);
    }
}

async function savePlatform() {
    const data = {
        name: document.getElementById('platformName').value,
        type: document.getElementById('platformType').value,
        rtmp_url: document.getElementById('rtmpUrl').value,
        stream_key: document.getElementById('streamKey').value
    };
    
    try {
        const response = await fetch('/api/platforms', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            closeModal('platformModal');
            document.getElementById('platformForm').reset();
            loadPlatforms();
            showNotification('success', 'Plataforma Guardada', 'La plataforma se guardó correctamente');
        } else {
            showNotification('error', 'Error', 'No se pudo guardar la plataforma');
        }
    } catch (error) {
        showNotification('error', 'Error', 'Error al guardar la plataforma');
    }
}

function updatePlatformHelp() {
    const type = document.getElementById('platformType').value;
    const rtmpUrl = document.getElementById('rtmpUrl');
    const rtmpHelp = document.getElementById('rtmpHelp');
    
    const urls = {
        youtube: 'rtmp://a.rtmp.youtube.com/live2',
        facebook: 'rtmps://live-api-s.facebook.com:443/rtmp',
        twitch: 'rtmp://live.twitch.tv/app',
        custom: ''
    };
    
    const helps = {
        youtube: 'Para YouTube: rtmp://a.rtmp.youtube.com/live2',
        facebook: 'Para Facebook: rtmps://live-api-s.facebook.com:443/rtmp',
        twitch: 'Para Twitch: rtmp://live.twitch.tv/app',
        custom: 'Ingresa la URL RTMP de tu plataforma'
    };
    
    rtmpUrl.value = urls[type];
    rtmpHelp.textContent = helps[type];
}

function showStreamModal(videoId, videoName) {
    currentVideoId = videoId;
    document.getElementById('streamVideoName').textContent = videoName;
    
    const platformsList = document.getElementById('platformsList');
    
    if (platforms.length === 0) {
        platformsList.innerHTML = `
            <p style="text-align: center; color: var(--text-secondary);">
                No hay plataformas configuradas.<br>
                Haz clic en "Agregar Plataforma" para comenzar.
            </p>
        `;
    } else {
        platformsList.innerHTML = platforms.map(platform => `
            <label class="platform-option">
                <input type="checkbox" value="${platform.id}" name="platform">
                <div class="platform-label">
                    <strong>${escapeHtml(platform.name)}</strong>
                    <span class="platform-type">${platform.type}</span>
                </div>
            </label>
        `).join('');
    }
    
    showModal('streamModal');
}

async function startStreaming() {
    const selectedPlatforms = Array.from(document.querySelectorAll('input[name="platform"]:checked'))
        .map(input => parseInt(input.value));
    
    if (selectedPlatforms.length === 0) {
        showNotification('warning', 'Atención', 'Selecciona al menos una plataforma');
        return;
    }
    
    const loopConfig = loopUI.getLoopConfig();
    
    try {
        const response = await fetch('/api/stream/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                videoId: currentVideoId,
                platformIds: selectedPlatforms,
                loopConfig: loopConfig ? { ...loopConfig, enabled: true } : null
            })
        });
        
        if (response.ok) {
            closeModal('streamModal');
            updateStreamStatus();
            showNotification('success', 'Transmisión Iniciada', 
                loopConfig ? 'La transmisión ha comenzado en bucle' : 'La transmisión ha comenzado');
        } else {
            showNotification('error', 'Error', 'No se pudo iniciar la transmisión');
        }
    } catch (error) {
        showNotification('error', 'Error', 'Error al iniciar la transmisión');
    }
}

async function updateStreamStatus() {
    try {
        const response = await fetch('/api/streams/status');
        const data = await response.json();
        
        const container = document.getElementById('activeStreams');
        
        if (data.activeStreams.length === 0) {
            container.innerHTML = `
                <p style="text-align: center; color: var(--text-secondary);">
                    No hay transmisiones activas
                </p>
            `;
            return;
        }
        
        container.innerHTML = data.activeStreams.map(stream => {
            const video = videos.find(v => v.id == stream.videoId);
            const platform = platforms.find(p => p.id == stream.platformId);
            
            return `
                <div class="stream-item" data-stream-key="${stream.key}">
                    <div class="stream-info">
                        <div class="stream-status"></div>
                        <div class="stream-details">
                            <h4>${video ? escapeHtml(video.original_name) : 'Video'}</h4>
                            <p>Transmitiendo en ${platform ? escapeHtml(platform.name) : 'Plataforma'}</p>
                            ${stream.loopActive ? `
                                <div class="loop-indicator active">
                                    <svg class="loop-icon spinning" width="16" height="16" viewBox="0 0 24 24" fill="none">
                                        <path d="M4 12C4 7.58172 7.58172 4 12 4C14.4817 4 16.7245 5.08421 18.2929 6.79289L16 9H22V3L19.6569 5.34315C17.7353 3.12169 14.9947 2 12 2C6.47715 2 2 6.47715 2 12H4ZM20 12C20 16.4183 16.4183 20 12 20C9.51828 20 7.27547 18.9158 5.70711 17.2071L8 15H2V21L4.34315 18.6569C6.26472 20.8783 9.00531 22 12 22C17.5228 22 22 17.5228 22 12H20Z" stroke="currentColor" stroke-width="2"/>
                                    </svg>
                                    <span class="loop-iteration">En bucle</span>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                    <button class="btn btn-danger btn-sm" onclick="stopStream(${stream.videoId}, ${stream.platformId})">
                        Detener
                    </button>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Error updating stream status:', error);
    }
}

async function stopStream(videoId, platformId) {
    try {
        const response = await fetch('/api/stream/stop', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ videoId, platformId })
        });
        
        if (response.ok) {
            updateStreamStatus();
            showNotification('info', 'Transmisión Detenida', 'La transmisión se detuvo correctamente');
        }
    } catch (error) {
        showNotification('error', 'Error', 'No se pudo detener la transmisión');
    }
}

function showModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

function showDropboxModal() {
    document.getElementById('dropboxUrl').value = '';
    showModal('dropboxModal');
}

function showPlatformModal() {
    showModal('platformModal');
}

function showSettingsModal() {
    checkDropboxAPIStatus();
    showModal('settingsModal');
}

function showDropboxAPIConfig() {
    closeModal('dropboxModal');
    showSettingsModal();
}

function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    event.target.classList.add('active');
    
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');
    
    if (tabName === 'schedule') {
        loadScheduledStreams();
    }
}

function showNotification(type, title, message) {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <div class="notification-header">
            <span class="notification-title">${title}</span>
            <button class="notification-close" onclick="this.parentElement.parentElement.remove()">&times;</button>
        </div>
        <p>${message}</p>
    `;
    
    document.getElementById('notifications').appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 5000);
}

function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('es-ES', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

async function showScheduleModal() {
    const videosResponse = await fetch('/api/videos');
    const videos = await videosResponse.json();
    
    const videoSelect = document.getElementById('scheduleVideo');
    videoSelect.innerHTML = '<option value="">-- Selecciona un video --</option>' +
        videos.map(v => `<option value="${v.id}">${escapeHtml(v.original_name)}</option>`).join('');
    
    const platformsResponse = await fetch('/api/platforms');
    const platforms = await platformsResponse.json();
    
    const platformsList = document.getElementById('schedulePlatformsList');
    platformsList.innerHTML = platforms.map(p => `
        <label class="platform-option">
            <input type="checkbox" value="${p.id}" name="schedulePlatform">
            <div class="platform-label">
                <strong>${escapeHtml(p.name)}</strong>
                <span class="platform-type">${p.type}</span>
            </div>
        </label>
    `).join('');
    
    document.querySelectorAll('.day-checkbox').forEach(label =>

label.classList.remove('selected'));
    
    showModal('scheduleModal');
}

async function saveSchedule() {
    const selectedDays = Array.from(document.querySelectorAll('.day-checkbox input:checked'))
        .map(cb => parseInt(cb.value));
    
    const selectedPlatforms = Array.from(document.querySelectorAll('input[name="schedulePlatform"]:checked'))
        .map(cb => parseInt(cb.value));
    
    const scheduleData = {
        videoId: parseInt(document.getElementById('scheduleVideo').value),
        platformIds: selectedPlatforms,
        scheduleDays: selectedDays,
        scheduleTime: document.getElementById('scheduleTime').value
    };
    
    if (!scheduleData.videoId || selectedPlatforms.length === 0 || selectedDays.length === 0 || !scheduleData.scheduleTime) {
        showNotification('warning', 'Atención', 'Por favor completa todos los campos');
        return;
    }
    
    try {
        const response = await fetch('/api/scheduled-streams', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(scheduleData)
        });
        
        if (response.ok) {
            closeModal('scheduleModal');
            loadScheduledStreams();
            showNotification('success', 'Programación Guardada', 'La transmisión se programó correctamente');
        } else {
            const error = await response.json();
            showNotification('error', 'Error', error.error || 'No se pudo programar la transmisión');
        }
    } catch (error) {
        showNotification('error', 'Error', 'Error al programar la transmisión');
    }
}

async function loadScheduledStreams() {
    try {
        const response = await fetch('/api/scheduled-streams');
        const schedules = await response.json();
        
        const container = document.getElementById('schedulesList');
        
        if (schedules.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" fill="none">
                        <path d="M8 7V3M16 7V3M7 11H17M5 21H19C20.1046 21 21 20.1046 21 19V7C21 5.89543 20.1046 5 19 5H5C3.89543 5 3 5.89543 3 7V19C3 20.1046 3.89543 21 5 21Z" stroke="currentColor" stroke-width="2"/>
                    </svg>
                    <p>No hay transmisiones programadas</p>
                </div>
            `;
            return;
        }
        
        const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        
        container.innerHTML = schedules.map(schedule => `
            <div class="schedule-item ${schedule.is_active ? '' : 'inactive'}">
                <div class="schedule-info">
                    <h4>${escapeHtml(schedule.video_name)}</h4>
                    <div class="schedule-details">
                        <p>Plataformas: ${schedule.platforms.map(p => escapeHtml(p.name)).join(', ')}</p>
                        <p>Días: ${schedule.schedule_days.map(d => dayNames[d]).join(', ')}</p>
                        <p>Hora: ${schedule.schedule_time}</p>
                    </div>
                </div>
                <div class="schedule-actions">
                    <button class="btn btn-sm ${schedule.is_active ? 'btn-secondary' : 'btn-primary'}" 
                            onclick="toggleSchedule(${schedule.id}, ${!schedule.is_active})">
                        ${schedule.is_active ? 'Desactivar' : 'Activar'}
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteSchedule(${schedule.id})">
                        Eliminar
                    </button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading scheduled streams:', error);
    }
}

async function toggleSchedule(scheduleId, activate) {
    try {
        const response = await fetch(`/api/scheduled-streams/${scheduleId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ isActive: activate })
        });
        
        if (response.ok) {
            loadScheduledStreams();
            showNotification('success', 'Actualizado', `Programación ${activate ? 'activada' : 'desactivada'}`);
        }
    } catch (error) {
        showNotification('error', 'Error', 'No se pudo actualizar la programación');
    }
}

async function deleteSchedule(scheduleId) {
    if (!confirm('¿Estás seguro de eliminar esta programación?')) return;
    
    try {
        const response = await fetch(`/api/scheduled-streams/${scheduleId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            loadScheduledStreams();
            showNotification('success', 'Eliminado', 'La programación se eliminó correctamente');
        }
    } catch (error) {
        showNotification('error', 'Error', 'No se pudo eliminar la programación');
    }
}

window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
});

window.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
});
