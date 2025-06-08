let currentVideoId = null;
let platforms = [];
let videos = [];

document.addEventListener('DOMContentLoaded', () => {
    loadVideos();
    loadPlatforms();
    setupEventListeners();
    setInterval(updateStreamStatus, 5000);
});

function setupEventListeners() {
    const uploadArea = document.getElementById('uploadArea');
    const videoInput = document.getElementById('videoInput');
    
    uploadArea.addEventListener('click', () => videoInput.click());
    
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragging');
    });
    
    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragging');
    });
    
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragging');
        
        const files = e.dataTransfer.files;
        if (files.length > 0 && files[0].type.startsWith('video/')) {
            handleFileUpload(files[0]);
        }
    });
    
    videoInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileUpload(e.target.files[0]);
        }
    });
    
    document.getElementById('platformForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await savePlatform();
    });
}

async function loadVideos() {
    try {
        const response = await fetch('/api/videos');
        videos = await response.json();
        renderVideos();
    } catch (error) {
        console.error('Error cargando videos:', error);
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
                <p>No hay videos subidos</p>
                <p>Haz clic en "Subir Video" para comenzar</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = videos.map(video => `
        <div class="video-card">
            <div class="video-info">
                <h3 class="video-name">${escapeHtml(video.original_name)}</h3>
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
    `).join('');
}

async function handleFileUpload(file) {
    const formData = new FormData();
    formData.append('video', file);
    
    const uploadProgress = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    
    uploadProgress.style.display = 'block';
    
    try {
        const xhr = new XMLHttpRequest();
        
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percentComplete = (e.loaded / e.total) * 100;
                progressFill.style.width = percentComplete + '%';
                progressText.textContent = `Subiendo... ${Math.round(percentComplete)}%`;
            }
        });
        
        xhr.addEventListener('load', () => {
            if (xhr.status === 200) {
                progressText.textContent = '¡Video subido con éxito!';
                setTimeout(() => {
                    closeModal('uploadModal');
                    uploadProgress.style.display = 'none';
                    progressFill.style.width = '0%';
                    loadVideos();
                }, 1500);
            } else {
                throw new Error('Error en la subida');
            }
        });
        
        xhr.addEventListener('error', () => {
            alert('Error al subir el video');
            uploadProgress.style.display = 'none';
        });
        
        xhr.open('POST', '/api/upload');
        xhr.send(formData);
        
    } catch (error) {
        alert('Error al subir el video: ' + error.message);
        uploadProgress.style.display = 'none';
    }
}

async function deleteVideo(videoId) {
    if (!confirm('¿Estás seguro de eliminar este video?')) return;
    
    try {
        const response = await fetch(`/api/videos/${videoId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            loadVideos();
        } else {
            alert('Error al eliminar el video');
        }
    } catch (error) {
        alert('Error al eliminar el video');
    }
}

async function loadPlatforms() {
    try {
        const response = await fetch('/api/platforms');
        platforms = await response.json();
    } catch (error) {
        console.error('Error cargando plataformas:', error);
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
            alert('Plataforma guardada con éxito');
        } else {
            alert('Error al guardar la plataforma');
        }
    } catch (error) {
        alert('Error al guardar la plataforma');
    }
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
        alert('Selecciona al menos una plataforma');
        return;
    }
    
    try {
        const response = await fetch('/api/stream/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                videoId: currentVideoId,
                platformIds: selectedPlatforms
            })
        });
        
        if (response.ok) {
            closeModal('streamModal');
            updateStreamStatus();
            alert('Transmisión iniciada');
        } else {
            alert('Error al iniciar la transmisión');
        }
    } catch (error) {
        alert('Error al iniciar la transmisión');
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
                <div class="stream-item">
                    <div class="stream-info">
                        <div class="stream-status"></div>
                        <div class="stream-details">
                            <h4>${video ? escapeHtml(video.original_name) : 'Video'}</h4>
                            <p>Transmitiendo en ${platform ? escapeHtml(platform.name) : 'Plataforma'}</p>
                        </div>
                    </div>
                    <button class="btn btn-danger btn-sm" onclick="stopStream(${stream.videoId}, ${stream.platformId})">
                        Detener
                    </button>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Error actualizando estado:', error);
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
        }
    } catch (error) {
        alert('Error al detener la transmisión');
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

function showModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

function showUploadModal() {
    showModal('uploadModal');
}

function showPlatformModal() {
    showModal('platformModal');
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
    if (bytes === 0) return '0 Bytes';
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
