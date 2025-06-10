const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');
const LoopManager = require('./loop-manager');
const FFmpegLoopBuilder = require('./ffmpeg-loop-builder');

class StreamScheduler extends EventEmitter {
    constructor(db) {
        super();
        this.db = db;
        this.scheduledJobs = new Map();
        this.activeStreams = new Map();
        this.loopManager = new LoopManager(db);
        this.ffmpegLoopBuilder = new FFmpegLoopBuilder();
    }

    async initialize() {
        await this.createTables();
        await this.loadScheduledStreams();
        await this.loopManager.initialize();
        
        cron.schedule('* * * * *', () => {
            this.checkScheduledStreams();
        });
        
        console.log('Stream Scheduler inicializado con soporte de bucles');
    }

    async createTables() {
        const createScheduledStreamsTable = `
            CREATE TABLE IF NOT EXISTS scheduled_streams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id INTEGER NOT NULL,
                platform_ids TEXT NOT NULL,
                schedule_days TEXT NOT NULL,
                schedule_time TIME NOT NULL,
                is_active BOOLEAN DEFAULT 1,
                loop_config TEXT,
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

    async checkScheduledStreams() {
        const now = new Date();
        const currentTime = now.toTimeString().slice(0, 5);
        const currentDay = now.getDay();

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
                    
                    if (scheduleDays.includes(currentDay) && 
                        schedule.schedule_time === currentTime &&
                        this.shouldRunNow(schedule)) {
                        
                        await this.executeScheduledStream(schedule);
                    }
                }
            }
        );
    }

    shouldRunNow(schedule) {
        if (!schedule.last_run) return true;
        
        const lastRun = new Date(schedule.last_run);
        const now = new Date();
        const diffMinutes = (now - lastRun) / (1000 * 60);
        
        return diffMinutes > 50;
    }

    async executeScheduledStream(schedule) {
        const platformIds = JSON.parse(schedule.platform_ids);
        
        const conflicts = await this.checkConflicts(platformIds);
        if (conflicts.length > 0) {
            await this.resolveConflicts(conflicts, schedule.id);
        }

        try {
            await this.startScheduledStream(schedule.video_id, platformIds, schedule);
            
            await this.updateLastRun(schedule.id);
            
            await this.logAction(schedule.id, 'started', 
                `Stream iniciado para video: ${schedule.original_name}`);
            
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

    async resolveConflicts(conflicts, scheduleId) {
        for (const conflict of conflicts) {
            try {
                conflict.process.kill('SIGTERM');
                
                this.activeStreams.delete(conflict.key);
                
                await this.updateStreamStatus(conflict.videoId, conflict.platformId, 'stopped');
                
                await this.logAction(scheduleId, 'conflict_resolved', 
                    `Stream detenido - Video ID: ${conflict.videoId}, Platform ID: ${conflict.platformId}`);
                
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

    async startScheduledStream(videoId, platformIds, schedule) {
        const video = await this.getVideo(videoId);
        const platforms = await this.getPlatforms(platformIds);
        
        let loopConfigId = null;
        if (schedule.loop_config) {
            const loopConfig = JSON.parse(schedule.loop_config);
            if (loopConfig.enabled) {
                const config = await this.loopManager.createLoopConfig({
                    type: loopConfig.type,
                    videoIds: loopConfig.videoIds || [videoId],
                    durationHours: loopConfig.durationHours,
                    repeatCount: loopConfig.repeatCount,
                    infinite: loopConfig.infinite,
                    name: `Scheduled - ${schedule.original_name}`
                });
                loopConfigId = config.id;
            }
        }
        
        for (const platform of platforms) {
            const streamKey = `${videoId}-${platform.id}`;
            const rtmpUrl = `${platform.rtmp_url}/${platform.stream_key}`;
            
            let ffmpegArgs;
            if (loopConfigId) {
                const videos = schedule.loop_config && JSON.parse(schedule.loop_config).videoIds ? 
                    await this.loopManager.validateVideoFiles(JSON.parse(schedule.loop_config).videoIds) : 
                    [video];
                    
                ffmpegArgs = await this.ffmpegLoopBuilder.createLoopCommand(videos, {
                    infinite: schedule.loop_config && JSON.parse(schedule.loop_config).infinite,
                    repeatCount: schedule.loop_config && JSON.parse(schedule.loop_config).repeatCount,
                    outputUrl: rtmpUrl
                });
            } else {
                ffmpegArgs = [
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
                ];
            }
            
            const ffmpeg = spawn('ffmpeg', ffmpegArgs);
            
            const streamId = await this.saveStreamRecord(videoId, platform.id, ffmpeg.pid, loopConfigId);
            
            this.activeStreams.set(streamKey, {
                process: ffmpeg,
                videoId,
                platformId: platform.id,
                startedAt: new Date(),
                streamId,
                loopConfigId
            });
            
            if (loopConfigId) {
                await this.loopManager.startLoopSession(loopConfigId, streamId);
            }
            
            ffmpeg.stderr.on('data', (data) => {
                console.log(`FFmpeg [scheduled ${streamKey}]: ${data}`);
            });
            
            ffmpeg.on('close', async (code) => {
                this.activeStreams.delete(streamKey);
                
                if (loopConfigId) {
                    await this.loopManager.endLoopSession(streamId);
                }
                
                await this.updateStreamStatus(videoId, platform.id, 
                    code === 0 ? 'completed' : 'error');
                
                this.emit('stream:scheduled:ended', {
                    videoId,
                    platformId: platform.id,
                    exitCode: code
                });
            });
        }
    }

    async createSchedule(data) {
        const { videoId, platformIds, scheduleDays, scheduleTime, loopConfig } = data;
        
        return new Promise((resolve, reject) => {
            const query = `
                INSERT INTO scheduled_streams 
                (video_id, platform_ids, schedule_days, schedule_time, loop_config) 
                VALUES (?, ?, ?, ?, ?)
            `;
            
            this.db.run(query, [
                videoId,
                JSON.stringify(platformIds),
                JSON.stringify(scheduleDays),
                scheduleTime,
                loopConfig ? JSON.stringify(loopConfig) : null
            ], function(err) {
                if (err) return reject(err);
                
                const scheduleId = this.lastID;
                
                this.updateNextRun(scheduleId);
                
                resolve({ id: scheduleId });
            });
        });
    }

    async updateNextRun(scheduleId) {
        const schedule = await this.getSchedule(scheduleId);
        if (!schedule) return;
        
        const scheduleDays = JSON.parse(schedule.schedule_days);
        const [hours, minutes] = schedule.schedule_time.split(':').map(Number);
        
        const now = new Date();
        let nextRun = new Date();
        
        for (let i = 0; i <= 7; i++) {
            const checkDate = new Date(now);
            checkDate.setDate(checkDate.getDate() + i);
            checkDate.setHours(hours, minutes, 0, 0);
            
            if (scheduleDays.includes(checkDate.getDay()) && checkDate > now) {
                nextRun = checkDate;
                break;
            }
        }
        
        this.db.run(
            'UPDATE scheduled_streams SET next_run = ? WHERE id = ?',
            [nextRun.toISOString(), scheduleId]
        );
    }

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

    async saveStreamRecord(videoId, platformId, pid, loopConfigId = null) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO streams (video_id, platform_id, status, process_pid, started_at, loop_config_id) VALUES (?, ?, ?, ?, datetime("now"), ?)',
                [videoId, platformId, 'streaming', pid, loopConfigId],
                function(err) {
                    if (err) return reject(err);
                    resolve(this.lastID);
                }
            );
        });
    }

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

    async updateSchedule(scheduleId, data) {
        const { platformIds, scheduleDays, scheduleTime, isActive, loopConfig } = data;
        
        return new Promise((resolve, reject) => {
            const query = `
                UPDATE scheduled_streams 
                SET platform_ids = ?, schedule_days = ?, schedule_time = ?, is_active = ?, loop_config = ?
                WHERE id = ?
            `;
            
            this.db.run(query, [
                JSON.stringify(platformIds),
                JSON.stringify(scheduleDays),
                scheduleTime,
                isActive ? 1 : 0,
                loopConfig ? JSON.stringify(loopConfig) : null,
                scheduleId
            ], (err) => {
                if (err) return reject(err);
                this.updateNextRun(scheduleId);
                resolve();
            });
        });
    }

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
