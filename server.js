const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const bytes = require('bytes');

const DropboxService = require('./dropbox-service');
const StreamScheduler = require('./scheduler');
const LoopManager = require('./loop-manager');
const FFmpegLoopBuilder = require('./ffmpeg-loop-builder');
const config = require('./config');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(cors());
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use('/api/', limiter);

const db = new sqlite3.Database('db/streamhub.db');

const dropboxService = new DropboxService(db);
const scheduler = new StreamScheduler(db);
const loopManager = new LoopManager(db);
const ffmpegLoopBuilder = new FFmpegLoopBuilder();

const activeStreams = new Map();
const activeDownloads = new Map();
const wsClients = new Map();
const streamHealthChecks = new Map();

wss.on('connection', (ws) => {
    const clientId = uuidv4();
    wsClients.set(clientId, ws);
    
    let pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    }, 30000);
    
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    
    ws.on('close', () => {
        clearInterval(pingInterval);
        wsClients.delete(clientId);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        clearInterval(pingInterval);
        wsClients.delete(clientId);
    });
    
    ws.send(JSON.stringify({
        type: 'connected',
        clientId
    }));
});

function broadcast(type, data) {
    const message = JSON.stringify({ type, data, timestamp: new Date() });
    wsClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (error) {
                console.error('Broadcast error:', error);
            }
        }
    });
}

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                original_name TEXT NOT NULL,
                path TEXT NOT NULL,
                size INTEGER,
                source TEXT DEFAULT 'local',
                dropbox_url TEXT,
                uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS platforms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                rtmp_url TEXT NOT NULL,
                stream_key TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS streams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id INTEGER,
                platform_id INTEGER,
                status TEXT DEFAULT 'stopped',
                process_pid INTEGER,
                started_at DATETIME,
                scheduled_at DATETIME,
                error_message TEXT,
                loop_config_id INTEGER,
                FOREIGN KEY (video_id) REFERENCES videos(id),
                FOREIGN KEY (platform_id) REFERENCES platforms(id),
                FOREIGN KEY (loop_config_id) REFERENCES loop_configurations(id)
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS dropbox_downloads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                download_id TEXT UNIQUE NOT NULL,
                dropbox_url TEXT NOT NULL,
                filename TEXT,
                size INTEGER,
                progress INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                error_message TEXT,
                video_id INTEGER,
                started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME,
                FOREIGN KEY (video_id) REFERENCES videos(id)
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS api_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                service TEXT NOT NULL,
                access_token TEXT,
                refresh_token TEXT,
                expires_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            db.run(`CREATE INDEX IF NOT EXISTS idx_downloads_status ON dropbox_downloads(status)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_downloads_download_id ON dropbox_downloads(download_id)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_videos_source ON videos(source)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status)`);
            
            resolve();
        });
    });
}

async function cleanupOldLogs() {
    const logsDir = path.join(__dirname, 'logs');
    try {
        const files = await fs.readdir(logsDir);
        const now = Date.now();
        const maxAge = 7 * 24 * 60 * 60 * 1000;
        
        for (const file of files) {
            const filePath = path.join(logsDir, file);
            const stats = await fs.stat(filePath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                await fs.unlink(filePath);
            }
        }
    } catch (error) {
        console.error('Error cleaning logs:', error);
    }
}

function startStreamHealthCheck(streamKey, ffmpegProcess) {
    const checkInterval = setInterval(() => {
        try {
            process.kill(ffmpegProcess.pid, 0);
        } catch (error) {
            clearInterval(checkInterval);
            streamHealthChecks.delete(streamKey);
            handleStreamCrash(streamKey);
        }
    }, 5000);
    
    streamHealthChecks.set(streamKey, checkInterval);
}

function stopStreamHealthCheck(streamKey) {
    const interval = streamHealthChecks.get(streamKey);
    if (interval) {
        clearInterval(interval);
        streamHealthChecks.delete(streamKey);
    }
}

async function handleStreamCrash(streamKey) {
    const stream = activeStreams.get(streamKey);
    if (stream) {
        activeStreams.delete(streamKey);
        scheduler.activeStreams.delete(streamKey);
        
        const [videoId, platformId] = streamKey.split('-');
        
        db.run(
            'UPDATE streams SET status = "crashed", error_message = "Stream crashed unexpectedly" WHERE video_id = ? AND platform_id = ? AND status = "streaming"',
            [videoId, platformId]
        );
        
        broadcast('stream_crashed', { videoId, platformId });
    }
}

async function validateVideoFile(videoPath) {
    try {
        await fs.access(videoPath);
        const stats = await fs.stat(videoPath);
        if (stats.size === 0) {
            throw new Error('Video file is empty');
        }
        return true;
    } catch (error) {
        throw new Error(`Invalid video file: ${error.message}`);
    }
}

async function initialize() {
    try {
        await initializeDatabase();
        await dropboxService.initialize();
        await scheduler.initialize();
        await loopManager.initialize();
        
        scheduler.activeStreams = activeStreams;
        
        scheduler.on('stream:scheduled:started', (data) => {
            broadcast('scheduled_stream_started', data);
        });
        
        scheduler.on('stream:scheduled:error', (data) => {
            broadcast('scheduled_stream_error', data);
        });
        
        scheduler.on('stream:conflict:resolved', (data) => {
            broadcast('stream_conflict_resolved', data);
        });
        
        scheduler.on('stream:scheduled:ended', (data) => {
            broadcast('scheduled_stream_ended', data);
        });
        
        dropboxService.on('download:progress', (data) => {
            broadcast('download_progress', data);
        });
        
        dropboxService.on('download:complete', (data) => {
            broadcast('download_complete', data);
        });
        
        dropboxService.on('download:error', (data) => {
            broadcast('download_error', data);
        });
        
        loopManager.on('loop:iteration', (data) => {
            broadcast('loop_iteration', data);
        });
        
        setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);
        
        console.log('Services initialized successfully');
    } catch (error) {
        console.error('Failed to initialize services:', error);
        process.exit(1);
    }
}

app.post('/api/loop/config', async (req, res) => {
    try {
        const config = await loopManager.createLoopConfig(req.body);
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/loop/active', async (req, res) => {
    try {
        const loops = await loopManager.getActiveLoops();
        res.json(loops);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/dropbox/download-url', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL de Dropbox requerida' });
        }
        
        const downloadId = uuidv4();
        const download = await dropboxService.downloadFromUrl(url, downloadId);
        
        activeDownloads.set(downloadId, download);
        
        res.json({
            downloadId,
            status: 'started',
            message: 'Descarga iniciada'
        });
        
    } catch (error) {
        console.error('Error starting download:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/dropbox/download/:downloadId/status', async (req, res) => {
    try {
        const { downloadId } = req.params;
        const status = await dropboxService.getDownloadStatus(downloadId);
        
        if (!status) {
            return res.status(404).json({ error: 'Descarga no encontrada' });
        }
        
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/dropbox/download/:downloadId/cancel', async (req, res) => {
    try {
        const { downloadId } = req.params;
        await dropboxService.cancelDownload(downloadId);
        
        activeDownloads.delete(downloadId);
        
        res.json({ success: true, message: 'Descarga cancelada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/dropbox/setup-api', async (req, res) => {
    try {
        const { accessToken, refreshToken } = req.body;
        
        if (!accessToken) {
            return res.status(400).json({ error: 'Access token requerido' });
        }
        
        await dropboxService.setupAPI(accessToken, refreshToken);
        
        res.json({
            success: true,
            message: 'API de Dropbox configurada correctamente'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/dropbox/api-status', async (req, res) => {
    try {
        const status = await dropboxService.getAPIStatus();
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/videos', (req, res) => {
    db.all('SELECT * FROM videos ORDER BY uploaded_at DESC', (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.delete('/api/videos/:id', async (req, res) => {
    const videoId = req.params.id;
    
    stopAllStreamsForVideo(videoId);
    
    db.get('SELECT * FROM videos WHERE id = ?', [videoId], async (err, video) => {
        if (err || !video) {
            res.status(404).json({ error: 'Video no encontrado' });
            return;
        }
        
        try {
            await fs.unlink(video.path);
        } catch (e) {
            console.error('Error deleting file:', e);
        }
        
        db.run('DELETE FROM streams WHERE video_id = ?', [videoId]);
        db.run('DELETE FROM videos WHERE id = ?', [videoId], (err) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ success: true });
        });
    });
});

app.get('/api/platforms', (req, res) => {
    db.all('SELECT * FROM platforms ORDER BY name', (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.post('/api/platforms', (req, res) => {
    const { name, type, rtmp_url, stream_key } = req.body;
    
    db.run(
        'INSERT INTO platforms (name, type, rtmp_url, stream_key) VALUES (?, ?, ?, ?)',
        [name, type, rtmp_url, stream_key],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({
                id: this.lastID,
                name,
                type
            });
        }
    );
});

app.put('/api/platforms/:id', (req, res) => {
    const { name, rtmp_url, stream_key } = req.body;
    
    db.run(
        'UPDATE platforms SET name = ?, rtmp_url = ?, stream_key = ? WHERE id = ?',
        [name, rtmp_url, stream_key, req.params.id],
        (err) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ success: true });
        }
    );
});

app.delete('/api/platforms/:id', (req, res) => {
    const platformId = req.params.id;
    
    stopAllStreamsForPlatform(platformId);
    
    db.run('DELETE FROM streams WHERE platform_id = ?', [platformId]);
    db.run('DELETE FROM platforms WHERE id = ?', [platformId], (err) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ success: true });
    });
});

app.post('/api/stream/start', async (req, res) => {
    const { videoId, platformIds, loopConfig } = req.body;
    
    try {
        const video = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM videos WHERE id = ?', [videoId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (!video) {
            res.status(404).json({ error: 'Video no encontrado' });
            return;
        }
        
        await validateVideoFile(video.path);
        
        let loopConfigId = null;
        if (loopConfig && loopConfig.enabled) {
            const config = await loopManager.createLoopConfig({
                type: loopConfig.type,
                videoIds: loopConfig.videoIds || [videoId],
                durationHours: loopConfig.durationHours,
                repeatCount: loopConfig.repeatCount,
                infinite: loopConfig.infinite
            });
            loopConfigId = config.id;
        }
        
        const results = [];
        
        for (const platformId of platformIds) {
            const platform = await new Promise((resolve, reject) => {
                db.get('SELECT * FROM platforms WHERE id = ?', [platformId], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });
            
            if (!platform) continue;
            
            const streamKey = `${videoId}-${platformId}`;
            if (activeStreams.has(streamKey)) {
                results.push({
                    platformId,
                    success: false,
                    error: 'Ya está transmitiendo'
                });
                continue;
            }
            
            const rtmpUrl = `${platform.rtmp_url}/${platform.stream_key}`;
            
            let ffmpegArgs;
            if (loopConfig && loopConfig.enabled) {
                const videos = loopConfig.videoIds ? 
                    await loopManager.validateVideoFiles(loopConfig.videoIds) : 
                    [video];
                    
                ffmpegArgs = await ffmpegLoopBuilder.createLoopCommand(videos, {
                    infinite: loopConfig.infinite,
                    repeatCount: loopConfig.repeatCount,
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
            
            const streamId = await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO streams (video_id, platform_id, status, process_pid, started_at, loop_config_id) VALUES (?, ?, ?, ?, datetime("now"), ?)',
                    [videoId, platformId, 'streaming', ffmpeg.pid, loopConfigId],
                    function(err) {
                        if (err) reject(err);
                        else resolve(this.lastID);
                    }
                );
            });
            
            activeStreams.set(streamKey, {
                process: ffmpeg,
                videoId,
                platformId,
                streamId,
                loopConfigId
            });
            
            scheduler.activeStreams.set(streamKey, {
                process: ffmpeg,
                videoId,
                platformId,
                streamId
            });
            
            if (loopConfigId) {
                await loopManager.startLoopSession(loopConfigId, streamId);
            }
            
            startStreamHealthCheck(streamKey, ffmpeg);
            
            ffmpeg.stderr.on('data', (data) => {
                console.log(`FFmpeg [${streamKey}]: ${data}`);
            });
            
            ffmpeg.on('close', async (code) => {
                stopStreamHealthCheck(streamKey);
                activeStreams.delete(streamKey);
                scheduler.activeStreams.delete(streamKey);
                
                if (loopConfigId) {
                    await loopManager.endLoopSession(streamId);
                }
                
                db.run(
                    'UPDATE streams SET status = ?, error_message = ? WHERE id = ?',
                    [code === 0 ? 'completed' : 'error', code !== 0 ? `Exit code: ${code}` : null, streamId]
                );
                
                broadcast('stream_ended', { videoId, platformId, code });
            });
            
            results.push({
                platformId,
                success: true,
                pid: ffmpeg.pid,
                loopEnabled: !!loopConfigId
            });
        }
        
        res.json({ results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/stream/stop', (req, res) => {
    const { videoId, platformId } = req.body;
    const streamKey = `${videoId}-${platformId}`;
    
    const stream = activeStreams.get(streamKey);
    if (stream) {
        stopStreamHealthCheck(streamKey);
        stream.process.kill('SIGTERM');
        activeStreams.delete(streamKey);
        scheduler.activeStreams.delete(streamKey);
        
        if (stream.loopConfigId) {
            loopManager.endLoopSession(stream.streamId);
        }
        
        db.run(
            'UPDATE streams SET status = "stopped" WHERE video_id = ? AND platform_id = ? AND status = "streaming"',
            [videoId, platformId]
        );
        
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Stream no encontrado' });
    }
});

app.get('/api/streams/status', async (req, res) => {
    const activeStreamsList = [];
    
    for (const [key, stream] of activeStreams) {
        const loopActive = stream.loopConfigId ? 
            await loopManager.shouldContinueLoop(stream.streamId) : false;
            
        activeStreamsList.push({
            key,
            videoId: stream.videoId,
            platformId: stream.platformId,
            pid: stream.process.pid,
            loopActive
        });
    }
    
    res.json({ activeStreams: activeStreamsList });
});

app.get('/api/streams/history', (req, res) => {
    db.all(`
        SELECT s.*, v.original_name as video_name, p.name as platform_name, p.type as platform_type,
               lc.type as loop_type, lc.infinite as loop_infinite
        FROM streams s
        JOIN videos v ON s.video_id = v.id
        JOIN platforms p ON s.platform_id = p.id
        LEFT JOIN loop_configurations lc ON s.loop_config_id = lc.id
        ORDER BY s.started_at DESC
        LIMIT 50
    `, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.get('/api/scheduled-streams', async (req, res) => {
    try {
        const schedules = await scheduler.getAllSchedules();
        
        const enrichedSchedules = await Promise.all(schedules.map(async (schedule) => {
            const platformIds = JSON.parse(schedule.platform_ids);
            const platforms = await scheduler.getPlatforms(platformIds);
            
            return {
                ...schedule,
                platform_ids: platformIds,
                schedule_days: JSON.parse(schedule.schedule_days),
                platforms: platforms.map(p => ({ id: p.id, name: p.name, type: p.type }))
            };
        }));
        
        res.json(enrichedSchedules);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/scheduled-streams', async (req, res) => {
    try {
        const { videoId, platformIds, scheduleDays, scheduleTime, loopConfig } = req.body;
        
        if (!videoId || !platformIds || !scheduleDays || !scheduleTime) {
            return res.status(400).json({ error: 'Faltan campos requeridos' });
        }
        
        if (!Array.isArray(platformIds) || platformIds.length === 0) {
            return res.status(400).json({ error: 'Debe seleccionar al menos una plataforma' });
        }
        
        if (!Array.isArray(scheduleDays) || scheduleDays.length === 0) {
            return res.status(400).json({ error: 'Debe seleccionar al menos un día' });
        }
        
        const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
        if (!timeRegex.test(scheduleTime)) {
            return res.status(400).json({ error: 'Formato de hora inválido (use HH:MM)' });
        }
        
        const result = await scheduler.createSchedule({
            videoId,
            platformIds,
            scheduleDays,
            scheduleTime,
            loopConfig
        });
        
        res.json({ success: true, scheduleId: result.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/scheduled-streams/:id', async (req, res) => {
    try {
        const scheduleId = parseInt(req.params.id);
        const { platformIds, scheduleDays, scheduleTime, isActive } = req.body;
        
        await scheduler.updateSchedule(scheduleId, {
            platformIds,
            scheduleDays,
            scheduleTime,
            isActive
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/scheduled-streams/:id', async (req, res) => {
    try {
        const scheduleId = parseInt(req.params.id);
        await scheduler.deleteSchedule(scheduleId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/scheduled-streams/:id/logs', async (req, res) => {
    try {
        const scheduleId = parseInt(req.params.id);
        const logs = await scheduler.getScheduleLogs(scheduleId);
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function stopAllStreamsForVideo(videoId) {
    activeStreams.forEach((stream, key) => {
        if (stream.videoId == videoId) {
            stopStreamHealthCheck(key);
            stream.process.kill('SIGTERM');
            activeStreams.delete(key);
            scheduler.activeStreams.delete(key);
        }
    });
}

function stopAllStreamsForPlatform(platformId) {
    activeStreams.forEach((stream, key) => {
        if (stream.platformId == platformId) {
            stopStreamHealthCheck(key);
            stream.process.kill('SIGTERM');
            activeStreams.delete(key);
            scheduler.activeStreams.delete(key);
        }
    });
}

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;
initialize().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`StreamHub ejecutándose en http://localhost:${PORT}`);
        console.log('WebSocket disponible para notificaciones en tiempo real');
        console.log('Sistema de bucles activado');
    });
}).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
