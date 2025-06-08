// scheduler.js - Servicio de programación de streams
const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

class StreamScheduler extends EventEmitter {
    constructor(db) {
        super();
        this.db = db;
        this.scheduledJobs = new Map();
        this.activeStreams = new Map(); // Mantener registro de streams activos
    }

    // Inicializar el scheduler
    async initialize() {
        await this.createTables();
        await this.loadScheduledStreams();
        
        // Verificar programaciones cada minuto
        cron.schedule('* * * * *', () => {
            this.checkScheduledStreams();
        });
        
        console.log('Stream Scheduler inicializado');
    }

    // Crear tablas si no existen
    async createTables() {
        const createScheduledStreamsTable = `
            CREATE TABLE IF NOT EXISTS scheduled_streams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id INTEGER NOT NULL,
                platform_ids TEXT NOT NULL,
                schedule_days TEXT NOT NULL,
                schedule_time TIME NOT NULL,
                is_active BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_run DATETIME,
                next_run DATETIME,
                FOREIGN KEY (video_id) REFERENCES videos(id)
            )
        `;

        const createScheduleLogsTable = `
            CREATE TABLE IF NOT EXISTS schedule_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scheduled_stream_id INTEGER,
                action TEXT NOT NULL,
                details TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (scheduled_stream_id) REFERENCES scheduled_streams(id)
            )
        `;

        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run(createScheduledStreamsTable, (err) => {
                    if (err && !err.message.includes('already exists')) {
                        return reject(err);
                    }
                });
                
                this.db.run(createScheduleLogsTable, (err) => {
                    if (err && !err.message.includes('already exists')) {
                        return reject(err);
                    }
                    resolve();
                });
            });
        });
    }

    // Cargar streams programados activos
    async loadScheduledStreams() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM scheduled_streams WHERE is_active = 1',
                (err, rows) => {
                    if (err) return reject(err);
                    
                    rows.forEach(schedule => {
                        this.updateNextRun(schedule.id);
                    });
                    
                    resolve(rows);
                }
            );
        });
    }

    // Verificar y ejecutar streams programados
    async checkScheduledStreams() {
        const now = new Date();
        const currentTime = now.toTimeString().slice(0, 5); // HH:MM
        const currentDay = now.getDay(); // 0-6

        this.db.all(
            `SELECT s.*, v.path, v.original_name 
             FROM scheduled_streams s 
             JOIN videos v ON s.video_id = v.id 
             WHERE s.is_active = 1`,
            async (err, rows) => {
                if (err) {
                    console.error('Error al verificar programaciones:', err);
                    return;
                }

                for (const schedule of rows) {
                    const scheduleDays = JSON.parse(schedule.schedule_days);
                    
                    // Verificar si es el día y hora correctos
                    if (scheduleDays.includes(currentDay) && 
                        schedule.schedule_time === currentTime &&
                        this.shouldRunNow(schedule)) {
                        
                        await this.executeScheduledStream(schedule);
                    }
                }
            }
        );
    }

    // Verificar si debe ejecutarse ahora
    shouldRunNow(schedule) {
        if (!schedule.last_run) return true;
        
        const lastRun = new Date(schedule.last_run);
        const now = new Date();
        const diffMinutes = (now - lastRun) / (1000 * 60);
        
        // No ejecutar si ya se ejecutó en los últimos 50 minutos
        return diffMinutes > 50;
    }

    // Ejecutar stream programado
    async executeScheduledStream(schedule) {
        const platformIds = JSON.parse(schedule.platform_ids);
        
        // Verificar conflictos y detener streams activos si es necesario
        const conflicts = await this.checkConflicts(platformIds);
        if (conflicts.length > 0) {
            await this.resolveConflicts(conflicts, schedule.id);
        }

        // Iniciar el nuevo stream
        try {
            await this.startScheduledStream(schedule.video_id, platformIds);
            
            // Actualizar última ejecución
            await this.updateLastRun(schedule.id);
            
            // Registrar en logs
            await this.logAction(schedule.id, 'started', 
                `Stream iniciado para video: ${schedule.original_name}`);
            
            // Emitir evento para notificación
            this.emit('stream:scheduled:started', {
                scheduleId: schedule.id,
                videoName: schedule.original_name,
                platforms: platformIds
            });
            
        } catch (error) {
            await this.logAction(schedule.id, 'error', error.message);
            
            this.emit('stream:scheduled:error', {
                scheduleId: schedule.id,
                error: error.message
            });
        }
    }

    // Verificar conflictos con streams activos
    async checkConflicts(platformIds) {
        const conflicts = [];
        
        for (const [key, stream] of this.activeStreams) {
            const [videoId, platformId] = key.split('-');
            
            if (platformIds.includes(parseInt(platformId))) {
                conflicts.push({
                    key,
                    videoId: parseInt(videoId),
                    platformId: parseInt(platformId),
                    process: stream.process
                });
            }
        }
        
        return conflicts;
    }

    // Resolver conflictos deteniendo streams activos
    async resolveConflicts(conflicts, scheduleId) {
        for (const conflict of conflicts) {
            try {
                // Detener el proceso
                conflict.process.kill('SIGTERM');
                
                // Remover del mapa de streams activos
                this.activeStreams.delete(conflict.key);
                
                // Actualizar base de datos
                await this.updateStreamStatus(conflict.videoId, conflict.platformId, 'stopped');
                
                // Registrar en logs
                await this.logAction(scheduleId, 'conflict_resolved', 
                    `Stream detenido - Video ID: ${conflict.videoId}, Platform ID: ${conflict.platformId}`);
                
                // Emitir evento
                this.emit('stream:conflict:resolved', {
                    scheduleId,
                    stoppedVideoId: conflict.videoId,
                    platformId: conflict.platformId
                });
                
            } catch (error) {
                console.error('Error al resolver conflicto:', error);
            }
        }
    }

    // Iniciar stream programado
    async startScheduledStream(videoId, platformIds) {
        // Obtener información del video y plataformas
        const video = await this.getVideo(videoId);
        const platforms = await this.getPlatforms(platformIds);
        
        for (const platform of platforms) {
            const streamKey = `${videoId}-${platform.id}`;
            const rtmpUrl = `${platform.rtmp_url}/${platform.stream_key}`;
            
            const ffmpeg = spawn('ffmpeg', [
                '-re',
                '-i', video.path,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-maxrate', '3000k',
                '-bufsize', '6000k',
                '-pix_fmt', 'yuv420p',
                '-g', '50',
                '-c:a', 'aac',
                '-b:a', '160k',
                '-ar', '44100',
                '-f', 'flv',
                rtmpUrl
            ]);
            
            this.activeStreams.set(streamKey, {
                process: ffmpeg,
                videoId,
                platformId: platform.id,
                startedAt: new Date()
            });
            
            // Guardar en base de datos
            await this.saveStreamRecord(videoId, platform.id, ffmpeg.pid);
            
            ffmpeg.stderr.on('data', (data) => {
                console.log(`FFmpeg [scheduled ${streamKey}]: ${data}`);
            });
            
            ffmpeg.on('close', (code) => {
                this.activeStreams.delete(streamKey);
                this.updateStreamStatus(videoId, platform.id, 
                    code === 0 ? 'completed' : 'error');
                
                // Emitir evento cuando el stream termine
                this.emit('stream:scheduled:ended', {
                    videoId,
                    platformId: platform.id,
                    exitCode: code
                });
            });
        }
    }

    // Crear nueva programación
    async createSchedule(data) {
        const { videoId, platformIds, scheduleDays, scheduleTime } = data;
        
        return new Promise((resolve, reject) => {
            const query = `
                INSERT INTO scheduled_streams 
                (video_id, platform_ids, schedule_days, schedule_time) 
                VALUES (?, ?, ?, ?)
            `;
            
            this.db.run(query, [
                videoId,
                JSON.stringify(platformIds),
                JSON.stringify(scheduleDays),
                scheduleTime
            ], function(err) {
                if (err) return reject(err);
                
                const scheduleId = this.lastID;
                
                // Calcular próxima ejecución
                this.updateNextRun(scheduleId);
                
                resolve({ id: scheduleId });
            });
        });
    }

    // Actualizar próxima ejecución
    async updateNextRun(scheduleId) {
        const schedule = await this.getSchedule(scheduleId);
        if (!schedule) return;
        
        const scheduleDays = JSON.parse(schedule.schedule_days);
        const [hours, minutes] = schedule.schedule_time.split(':').map(Number);
        
        const now = new Date();
        let nextRun = new Date();
        
        // Encontrar el próximo día programado
        for (let i = 0; i <= 7; i++) {
            const checkDate = new Date(now);
            checkDate.setDate(checkDate.getDate() + i);
            checkDate.setHours(hours, minutes, 0, 0);
            
            if (scheduleDays.includes(checkDate.getDay()) && checkDate > now) {
                nextRun = checkDate;
                break;
            }
        }
        
        // Actualizar en base de datos
        this.db.run(
            'UPDATE scheduled_streams SET next_run = ? WHERE id = ?',
            [nextRun.toISOString(), scheduleId]
        );
    }

    // Actualizar última ejecución
    async updateLastRun(scheduleId) {
        const now = new Date().toISOString();
        
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE scheduled_streams SET last_run = ? WHERE id = ?',
                [now, scheduleId],
                (err) => {
                    if (err) return reject(err);
                    this.updateNextRun(scheduleId);
                    resolve();
                }
            );
        });
    }

    // Registrar acción en logs
    async logAction(scheduleId, action, details) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO schedule_logs (scheduled_stream_id, action, details) VALUES (?, ?, ?)',
                [scheduleId, action, details],
                (err) => {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });
    }

    // Obtener información del video
    async getVideo(videoId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM videos WHERE id = ?',
                [videoId],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                }
            );
        });
    }

    // Obtener información de plataformas
    async getPlatforms(platformIds) {
        return new Promise((resolve, reject) => {
            const placeholders = platformIds.map(() => '?').join(',');
            this.db.all(
                `SELECT * FROM platforms WHERE id IN (${placeholders})`,
                platformIds,
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });
    }

    // Obtener programación por ID
    async getSchedule(scheduleId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM scheduled_streams WHERE id = ?',
                [scheduleId],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                }
            );
        });
    }

    // Guardar registro de stream
    async saveStreamRecord(videoId, platformId, pid) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO streams (video_id, platform_id, status, process_pid, started_at) VALUES (?, ?, ?, ?, datetime("now"))',
                [videoId, platformId, 'streaming', pid],
                (err) => {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });
    }

    // Actualizar estado del stream
    async updateStreamStatus(videoId, platformId, status) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE streams SET status = ? WHERE video_id = ? AND platform_id = ? AND status = "streaming"',
                [status, videoId, platformId],
                (err) => {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });
    }

    // Obtener todas las programaciones
    async getAllSchedules() {
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT s.*, v.original_name as video_name 
                FROM scheduled_streams s
                JOIN videos v ON s.video_id = v.id
                ORDER BY s.created_at DESC
            `, (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            });
        });
    }

    // Actualizar programación
    async updateSchedule(scheduleId, data) {
        const { platformIds, scheduleDays, scheduleTime, isActive } = data;
        
        return new Promise((resolve, reject) => {
            const query = `
                UPDATE scheduled_streams 
                SET platform_ids = ?, schedule_days = ?, schedule_time = ?, is_active = ?
                WHERE id = ?
            `;
            
            this.db.run(query, [
                JSON.stringify(platformIds),
                JSON.stringify(scheduleDays),
                scheduleTime,
                isActive ? 1 : 0,
                scheduleId
            ], (err) => {
                if (err) return reject(err);
                this.updateNextRun(scheduleId);
                resolve();
            });
        });
    }

    // Eliminar programación
    async deleteSchedule(scheduleId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM scheduled_streams WHERE id = ?',
                [scheduleId],
                (err) => {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });
    }

    // Obtener logs de programación
    async getScheduleLogs(scheduleId, limit = 50) {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM schedule_logs WHERE scheduled_stream_id = ? ORDER BY created_at DESC LIMIT ?',
                [scheduleId, limit],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });
    }
}

module.exports = StreamScheduler;
