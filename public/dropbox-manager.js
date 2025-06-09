class DropboxManager {
    constructor() {
        this.activeDownloads = new Map();
        this.setupEventListeners();
    }

    setupEventListeners() {
        // URL validation on input
        const urlInput = document.getElementById('dropboxUrl');
        if (urlInput) {
            urlInput.addEventListener('input', (e) => {
                this.validateDropboxUrl(e.target.value);
            });
        }
    }

    validateDropboxUrl(url) {
        const input = document.getElementById('dropboxUrl');
        const isValid = this.isValidDropboxUrl(url);
        
        if (url && !isValid) {
            input.classList.add('invalid');
            this.showUrlError('URL de Dropbox no válida');
        } else {
            input.classList.remove('invalid');
            this.hideUrlError();
        }
        
        return isValid;
    }

    isValidDropboxUrl(url) {
        if (!url) return true; // Empty is valid (will be caught on submit)
        
        const dropboxPatterns = [
            /^https?:\/\/(www\.)?dropbox\.com\/(s|sh)\//,
            /^https?:\/\/dl\.dropboxusercontent\.com\//,
            /^https?:\/\/(www\.)?dropbox\.com\/scl\/fi\//
        ];
        
        return dropboxPatterns.some(pattern => pattern.test(url));
    }

    showUrlError(message) {
        let errorDiv = document.getElementById('dropboxUrlError');
        if (!errorDiv) {
            errorDiv = document.createElement('div');
            errorDiv.id = 'dropboxUrlError';
            errorDiv.className = 'form-error';
            const urlInput = document.getElementById('dropboxUrl');
            urlInput.parentNode.appendChild(errorDiv);
        }
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
    }

    hideUrlError() {
        const errorDiv = document.getElementById('dropboxUrlError');
        if (errorDiv) {
            errorDiv.style.display = 'none';
        }
    }

    formatDropboxUrl(url) {
        // Ensure the URL has dl=1 parameter
        let formattedUrl = url;
        
        if (url.includes('dl=0')) {
            formattedUrl = url.replace('dl=0', 'dl=1');
        } else if (!url.includes('dl=')) {
            const separator = url.includes('?') ? '&' : '?';
            formattedUrl = url + separator + 'dl=1';
        }
        
        return formattedUrl;
    }

    async checkStorageQuota() {
        if ('storage' in navigator && 'estimate' in navigator.storage) {
            try {
                const estimate = await navigator.storage.estimate();
                const percentUsed = (estimate.usage / estimate.quota * 100).toFixed(2);
                
                console.log(`Storage: ${formatFileSize(estimate.usage)} / ${formatFileSize(estimate.quota)} (${percentUsed}%)`);
                
                if (percentUsed > 90) {
                    showNotification('warning', 'Espacio Limitado', 
                        'El espacio de almacenamiento local está casi lleno. Considera eliminar videos antiguos.');
                }
                
                return estimate;
            } catch (error) {
                console.error('Error checking storage quota:', error);
            }
        }
    }

    createDownloadCard(downloadId, url) {
        const card = document.createElement('div');
        card.id = `download-${downloadId}`;
        card.className = 'download-card';
        card.innerHTML = `
            <div class="download-header">
                <div class="download-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="currentColor"/>
                        <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" fill="none"/>
                    </svg>
                </div>
                <div class="download-info">
                    <p class="download-url">${this.truncateUrl(url)}</p>
                    <p class="download-status">Preparando descarga...</p>
                </div>
                <button class="btn-icon download-cancel" onclick="dropboxManager.cancelDownload('${downloadId}')">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                        <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2"/>
                    </svg>
                </button>
            </div>
            <div class="download-progress">
                <div class="progress-bar">
                    <div class="progress-fill" style="width: 0%"></div>
                </div>
                <div class="progress-info">
                    <span class="progress-percent">0%</span>
                    <span class="progress-speed">--</span>
                    <span class="progress-size">--</span>
                </div>
            </div>
        `;
        
        return card;
    }

    truncateUrl(url) {
        const maxLength = 50;
        if (url.length <= maxLength) return url;
        
        const start = url.substring(0, 25);
        const end = url.substring(url.length - 20);
        return `${start}...${end}`;
    }

    updateDownloadCard(downloadId, data) {
        const card = document.getElementById(`download-${downloadId}`);
        if (!card) return;
        
        const statusEl = card.querySelector('.download-status');
        const progressFill = card.querySelector('.progress-fill');
        const percentEl = card.querySelector('.progress-percent');
        const speedEl = card.querySelector('.progress-speed');
        const sizeEl = card.querySelector('.progress-size');
        
        if (data.status) {
            statusEl.textContent = this.getStatusText(data.status);
        }
        
        if (data.progress !== undefined) {
            progressFill.style.width = `${data.progress}%`;
            percentEl.textContent = `${data.progress}%`;
        }
        
        if (data.speed) {
            speedEl.textContent = data.speed;
        }
        
        if (data.downloadedBytes && data.totalBytes) {
            sizeEl.textContent = `${formatFileSize(data.downloadedBytes)} / ${formatFileSize(data.totalBytes)}`;
        }
    }

    getStatusText(status) {
        const statusTexts = {
            'starting': 'Iniciando descarga...',
            'downloading': 'Descargando...',
            'completed': 'Descarga completada',
            'error': 'Error en la descarga',
            'cancelled': 'Descarga cancelada'
        };
        
        return statusTexts[status] || status;
    }

    removeDownloadCard(downloadId) {
        const card = document.getElementById(`download-${downloadId}`);
        if (card) {
            card.classList.add('fade-out');
            setTimeout(() => card.remove(), 300);
        }
    }

    async cancelDownload(downloadId) {
        if (!confirm('¿Cancelar esta descarga?')) return;
        
        try {
            const response = await fetch(`/api/dropbox/download/${downloadId}/cancel`, {
                method: 'POST'
            });
            
            if (response.ok) {
                this.removeDownloadCard(downloadId);
                this.activeDownloads.delete(downloadId);
            }
        } catch (error) {
            console.error('Error cancelling download:', error);
        }
    }

    showDropboxTips() {
        const tips = [
            'Puedes copiar el enlace desde Dropbox haciendo clic en "Compartir" > "Copiar enlace"',
            'Los enlaces con dl=0 se convertirán automáticamente a dl=1 para descarga directa',
            'Para mejores velocidades, usa enlaces de archivos individuales en lugar de carpetas',
            'La API de Dropbox permite gestionar descargas más eficientemente'
        ];
        
        const randomTip = tips[Math.floor(Math.random() * tips.length)];
        
        const tipEl = document.createElement('div');
        tipEl.className = 'dropbox-tip';
        tipEl.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" fill="currentColor"/>
            </svg>
            ${randomTip}
        `;
        
        return tipEl;
    }

    // Batch download support
    async batchDownload(urls) {
        const results = [];
        
        for (const url of urls) {
            try {
                const response = await fetch('/api/dropbox/download-url', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ url })
                });
                
                if (response.ok) {
                    const result = await response.json();
                    results.push({ url, success: true, downloadId: result.downloadId });
                } else {
                    results.push({ url, success: false, error: 'Failed to start download' });
                }
            } catch (error) {
                results.push({ url, success: false, error: error.message });
            }
        }
        
        return results;
    }
}

// Initialize dropbox manager
const dropboxManager = new DropboxManager();

// Export for use in other scripts
window.dropboxManager = dropboxManager;
