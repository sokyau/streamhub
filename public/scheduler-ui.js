// scheduler-ui.js - Interfaz de usuario para programación de streams

// WebSocket para notificaciones en tiempo real
let ws = null;

// Conectar WebSocket
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('WebSocket conectado');
    };
    
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
    };
    
    ws.onclose = () => {
        console.log('WebSocket desconectado, reconectando...');
        setTimeout(connectWebSocket, 3000);
    };
    
    ws.onerror = (error) => {
        console.error('Error en WebSocket:', error);
    };
}

// Manejar mensajes del WebSocket
function handleWebSocketMessage(message) {
    const { type, data } = message;
    
    switch (type) {
        case 'scheduled_stream_started':
            showNotification('info', 'Transmisión Programada Iniciada', 
                `Se inició la transmisión de "${data.videoName}"`);
            updateStreamStatus();
            break;
            
        case 'scheduled_stream_error':
            showNotification('error', 'Error en Transmisión Programada', 
                `Error al iniciar stream: ${data.error}`);
            break;
            
        case 'stream_conflict_resolved':
            showNotification('warning', 'Conflicto Resuelto', 
                `Se detuvo un stream activo para iniciar la transmisión programada`);
            break;
            
        case 'scheduled_stream_ended':
            showNotification('info', 'Transmisión Finalizada', 
                `Finalizó la transmisión programada`);
            updateStreamStatus();
            break;
    }
}

// Cambiar entre tabs
function switchTab(tabName) {
    // Actualizar tabs activos
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    event.target.classList.add('active');
    
    // Mostrar contenido correspondiente
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');
    
    // Cargar datos si es necesario
    if (tabName === 'schedule') {
        loadScheduledStreams();
    }
}

// Cargar programaciones
async function loadScheduledStreams() {
    try {
        const response = await fetch('/api/scheduled-streams');
        const schedules = await response.json();
        renderSchedules(schedules);
    } catch (error) {
        console.error('Error cargando programaciones:', error);
    }
}

// Renderizar programaciones
function renderSchedules(schedules) {
    const container = document.getElementById('schedulesList');
    
    if (schedules.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" fill="currentColor"/>
                </svg>
                <p>No hay programaciones configuradas</p>
                <p>Crea una nueva programación para automatizar tus transmisiones</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = schedules.map(schedule => {
        const daysNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        const scheduledDays = schedule.schedule_days.map(d => daysNames[d]).join(', ');
        const nextRun = schedule.next_run ? new Date(schedule.next_run).toLocaleString('es-ES') : 'No programado';
        
        return `
            <div class="schedule-card">
                <div class="schedule-header">
                    <div class="schedule-info">
                        <h3>${escapeHtml(schedule.video_name)}</h3>
                        <div class="schedule-meta">
                            <div>
                                <strong>Días:</strong> ${scheduledDays}
                            </div>
                            <div>
                                <strong>Hora:</strong> ${schedule.schedule_time}
                            </div>
                            <div>
                                <strong>Próxima transmisión:</strong> ${nextRun}
                            </div>
                        </div>
                        <div class="platforms-badges">
                            ${schedule.platforms.map(p => `
                                <span class="platform-badge">${escapeHtml(p.name)}</span>
                            `).join('')}
                        </div>
                    </div>
                    <div class="schedule-actions">
                        <span class="status-badge ${schedule.is_active ? 'active' : 'inactive'}">
                            ${schedule.is_active ? 'Activo' : 'Inactivo'}
                        </span>
                    </div>
                </div>
                <div class="schedule-actions" style="display: flex; gap: 0.5rem; margin-top: 1rem;">
                    <button class="btn btn-sm ${schedule.is_active ? 'btn-secondary' : 'btn-primary'}" 
                            onclick="toggleSchedule(${schedule.id}, ${!schedule.is_active})">
                        ${schedule.is_active ? 'Desactivar' : 'Activar'}
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="showScheduleLogs(${schedule.id})">
                        Ver Logs
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteSchedule(${schedule.id})">
                        Eliminar
                    </button>
                </div>
                <div id="logs-${schedule.id}" class="schedule-logs" style="display: none;">
                    <!-- Los logs se cargarán aquí -->
                </div>
            </div>
        `;
    }).join('');
}

// Mostrar modal de programación
async function showScheduleModal() {
    // Cargar videos disponibles
    const videosResponse = await fetch('/api/videos');
    const videos = await videosResponse.json();
    
    const videoSelect = document.getElementById('scheduleVideo');
    videoSelect.innerHTML = '<option value="">-- Selecciona un video --</option>' +
        videos.map(v => `<option value="${v.id}">${escapeHtml(v.original_name)}</option>`).join('');
    
    // Cargar plataformas disponibles
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
    
    // Configurar checkboxes de días
    document.querySelectorAll('.day-checkbox').forEach(label => {
        const checkbox = label.querySelector('input');
        label.onclick = () => {
            checkbox.checked = !checkbox.checked;
            label.classList.toggle('selected', checkbox.checked);
        };
    });
    
    showModal('scheduleModal');
}

// Guardar programación
document.getElementById('scheduleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const videoId = document.getElementById('scheduleVideo').value;
    const scheduleTime = document.getElementById('scheduleTime').value;
    
    const scheduleDays = Array.from(document.querySelectorAll('input[name="scheduleDays"]:checked'))
        .map(input => parseInt(input.value));
    
    const platformIds = Array.from(document.querySelectorAll('input[name="schedulePlatform"]:checked'))
        .map(input => parseInt(input.value));
    
    if (!videoId || scheduleDays.length === 0 || platformIds.length === 0 || !scheduleTime) {
        alert('Por favor completa todos los campos');
        return;
    }
    
    try {
        const response = await fetch('/api/scheduled-streams', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                videoId: parseInt(videoId),
                platformIds,
                scheduleDays,
                scheduleTime
            })
        });
        
        if (response.ok) {
            closeModal('scheduleModal');
            document.getElementById('scheduleForm').reset();
            document.querySelectorAll('.day-checkbox').forEach(label => {
                label.classList.remove('selected');
            });
            loadScheduledStreams();
            showNotification('success', 'Programación Creada', 'La programación se guardó correctamente');
        } else {
            const error = await response.json();
            alert('Error al guardar la programación: ' + error.error);
        }
    } catch (error) {
        alert('Error al guardar la programación');
    }
});

// Activar/Desactivar programación
async function toggleSchedule(scheduleId, activate) {
    try {
        const response = await fetch(`/api/scheduled-streams/${scheduleId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                isActive: activate
            })
        });
        
        if (response.ok) {
            loadScheduledStreams();
            showNotification('success', activate ? 'Programación Activada' : 'Programación Desactivada', 
                `La programación fue ${activate ? 'activada' : 'desactivada'} correctamente`);
        }
    } catch (error) {
        alert('Error al actualizar la programación');
    }
}

// Eliminar programación
async function deleteSchedule(scheduleId) {
    if (!confirm('¿Estás seguro de eliminar esta programación?')) return;
    
    try {
        const response = await fetch(`/api/scheduled-streams/${scheduleId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            loadScheduledStreams();
            showNotification('success', 'Programación Eliminada', 'La programación fue eliminada correctamente');
        }
    } catch (error) {
        alert('Error al eliminar la programación');
    }
}

// Mostrar logs de programación
async function showScheduleLogs(scheduleId) {
    const logsContainer = document.getElementById(`logs-${scheduleId}`);
    
    if (logsContainer.style.display === 'none') {
        // Cargar logs
        try {
            const response = await fetch(`/api/scheduled-streams/${scheduleId}/logs`);
            const logs = await response.json();
            
            if (logs.length === 0) {
                logsContainer.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">No hay logs disponibles</p>';
            } else {
                logsContainer.innerHTML = logs.map(log => {
                    const date = new Date(log.created_at);
                    return `
                        <div class="log-entry">
                            <span class="log-time">${date.toLocaleString('es-ES')}</span>
                            <span class="log-action ${log.action}">${log.action}</span>
                            <span class="log-details">${log.details || ''}</span>
                        </div>
                    `;
                }).join('');
            }
            
            logsContainer.style.display = 'block';
        } catch (error) {
            console.error('Error cargando logs:', error);
        }
    } else {
        logsContainer.style.display = 'none';
    }
}

// Sistema de notificaciones
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
    
    // Auto-eliminar después de 5 segundos
    setTimeout(() => {
        notification.remove();
    }, 5000);
}

// Inicializar al cargar la página
document.addEventListener('DOMContentLoaded', () => {
    connectWebSocket();
});
