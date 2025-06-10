class LoopUI {
    constructor() {
        this.selectedVideos = [];
        this.loopConfig = {
            enabled: false,
            type: 'infinite',
            videos: [],
            hours: 1,
            count: 1
        };
    }

    init() {
        this.createLoopControls();
        this.attachEventListeners();
    }

    createLoopControls() {
        const loopSection = document.createElement('div');
        loopSection.className = 'loop-controls-section';
        loopSection.innerHTML = `
            <div class="loop-toggle-container">
                <label class="toggle-switch">
                    <input type="checkbox" id="loopEnabled" onchange="loopUI.toggleLoop(this.checked)">
                    <span class="toggle-slider"></span>
                </label>
                <span class="toggle-label">Activar Bucle</span>
            </div>
            
            <div id="loopOptions" class="loop-options" style="display: none;">
                <div class="loop-type-selector">
                    <label>
                        <input type="radio" name="loopType" value="infinite" checked onchange="loopUI.setLoopType('infinite')">
                        <span>Bucle Infinito</span>
                    </label>
                    <label>
                        <input type="radio" name="loopType" value="hours" onchange="loopUI.setLoopType('hours')">
                        <span>Por Horas</span>
                    </label>
                    <label>
                        <input type="radio" name="loopType" value="count" onchange="loopUI.setLoopType('count')">
                        <span>Por Repeticiones</span>
                    </label>
                </div>
                
                <div id="loopHoursConfig" class="loop-config-section" style="display: none;">
                    <label>Duración (horas):</label>
                    <input type="number" id="loopHours" min="1" max="24" value="1" onchange="loopUI.setHours(this.value)">
                </div>
                
                <div id="loopCountConfig" class="loop-config-section" style="display: none;">
                    <label>Repeticiones:</label>
                    <input type="number" id="loopCount" min="1" max="100" value="1" onchange="loopUI.setCount(this.value)">
                </div>
                
                <div id="loopVideoList" class="loop-video-list" style="display: none;">
                    <label>Videos en bucle:</label>
                    <div id="selectedLoopVideos"></div>
                    <button class="btn btn-sm btn-secondary" onclick="loopUI.showVideoSelector()">
                        Agregar Videos
                    </button>
                </div>
            </div>
        `;
        
        return loopSection;
    }

    toggleLoop(enabled) {
        this.loopConfig.enabled = enabled;
        document.getElementById('loopOptions').style.display = enabled ? 'block' : 'none';
        
        if (enabled && this.loopConfig.type === 'playlist' && this.selectedVideos.length === 0) {
            document.getElementById('loopVideoList').style.display = 'block';
        }
    }

    setLoopType(type) {
        this.loopConfig.type = type;
        
        document.getElementById('loopHoursConfig').style.display = type === 'hours' ? 'block' : 'none';
        document.getElementById('loopCountConfig').style.display = type === 'count' ? 'block' : 'none';
        document.getElementById('loopVideoList').style.display = type === 'playlist' ? 'block' : 'none';
    }

    setHours(hours) {
        this.loopConfig.hours = parseInt(hours);
    }

    setCount(count) {
        this.loopConfig.count = parseInt(count);
    }

    showVideoSelector() {
        const modal = document.createElement('div');
        modal.className = 'modal active';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Seleccionar Videos para Bucle</h3>
                    <button class="close-btn" onclick="this.parentElement.parentElement.parentElement.remove()">&times;</button>
                </div>
                <div class="modal-body">
                    <div id="videoSelectorList" class="video-selector-list"></div>
                </div>
                <div class="modal-actions">
                    <button class="btn btn-primary" onclick="loopUI.confirmVideoSelection()">Confirmar</button>
                    <button class="btn btn-secondary" onclick="this.parentElement.parentElement.parentElement.remove()">Cancelar</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        this.loadVideosForSelection();
    }

    async loadVideosForSelection() {
        try {
            const response = await fetch('/api/videos');
            const videos = await response.json();
            
            const container = document.getElementById('videoSelectorList');
            container.innerHTML = videos.map(video => `
                <label class="video-select-option">
                    <input type="checkbox" value="${video.id}" data-name="${escapeHtml(video.original_name)}">
                    <span>${escapeHtml(video.original_name)}</span>
                </label>
            `).join('');
        } catch (error) {
            console.error('Error loading videos:', error);
        }
    }

    confirmVideoSelection() {
        const checkboxes = document.querySelectorAll('#videoSelectorList input[type="checkbox"]:checked');
        this.selectedVideos = Array.from(checkboxes).map(cb => ({
            id: parseInt(cb.value),
            name: cb.dataset.name
        }));
        
        this.updateSelectedVideosList();
        document.querySelector('.modal.active').remove();
    }

    updateSelectedVideosList() {
        const container = document.getElementById('selectedLoopVideos');
        container.innerHTML = this.selectedVideos.map((video, index) => `
            <div class="selected-video-item">
                <span>${index + 1}. ${escapeHtml(video.name)}</span>
                <button class="btn-remove" onclick="loopUI.removeVideo(${index})">&times;</button>
            </div>
        `).join('');
    }

    removeVideo(index) {
        this.selectedVideos.splice(index, 1);
        this.updateSelectedVideosList();
    }

    getLoopConfig() {
        if (!this.loopConfig.enabled) return null;
        
        const config = {
            type: this.loopConfig.type,
            infinite: this.loopConfig.type === 'infinite'
        };
        
        if (this.loopConfig.type === 'hours') {
            config.durationHours = this.loopConfig.hours;
        } else if (this.loopConfig.type === 'count') {
            config.repeatCount = this.loopConfig.count;
        }
        
        if (this.loopConfig.type === 'playlist') {
            config.videoIds = this.selectedVideos.map(v => v.id);
        }
        
        return config;
    }

    attachEventListeners() {
        document.addEventListener('DOMContentLoaded', () => {
            const streamModal = document.getElementById('streamModal');
            if (streamModal) {
                const modalBody = streamModal.querySelector('.modal-body');
                const loopSection = this.createLoopControls();
                modalBody.insertBefore(loopSection, modalBody.querySelector('.modal-actions'));
            }
        });
    }

    showLoopIndicator(streamElement) {
        const indicator = document.createElement('div');
        indicator.className = 'loop-indicator';
        indicator.innerHTML = `
            <svg class="loop-icon spinning" width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 2V6M12 18V22M4 12H2M6.31412 6.31412L4.8999 4.8999M17.6859 6.31412L19.1001 4.8999M6.31412 17.69L4.8999 19.1001M17.6859 17.69L19.1001 19.1001M22 12H20M12 8C10 8 8 10 8 12C8 14 10 16 12 16C14 16 16 14 16 12C16 10 14 8 12 8Z" stroke="currentColor" stroke-width="2"/>
            </svg>
            <span>En bucle</span>
        `;
        streamElement.appendChild(indicator);
    }
}

const loopUI = new LoopUI();
loopUI.init();
