const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const StreamScheduler = require('./scheduler'); // Nueva importación

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración WebSocket para notificaciones en tiempo real
const http = require('http');
const WebSocket = require('ws');
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = 'uploads/';
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = crypto.randomBytes(16).toString('hex') + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('db/streamhub.db');

// Inicializar el scheduler
const scheduler = new StreamScheduler(db);

// WebSocket broadcast
function broadcast(type, data) {
    const message = JSON.stringify({ type, data });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Configurar eventos del scheduler para notificaciones
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

// Inicializar base de datos y scheduler
db.serialize(() => {
    // Tablas existentes
    db.run(`CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER,
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
        FOREIGN KEY (video_id) REFERENCES videos(id),
        FOREIGN KEY (platform_id) REFERENCES platforms(id)
    )`);
    
    // Inicializar scheduler después de crear tablas
    scheduler.initialize().then(() => {
        console.log('Scheduler inicializado correctamente');
    }).catch(err => {
        console.error('Error al inicializar scheduler:', err);
    });
});

const activeStreams = new Map();

// ========== ENDPOINTS EXISTENTES ==========

app.post('/api/upload', upload.single('video'), async (req, res) => {
    try {
        const { filename, originalname, path: filepath, size } = req.file;
        
        db.run(
            'INSERT INTO videos (filename, original_name, path, size) VALUES (?, ?, ?, ?)',
            [filename, originalname, filepath, size],
            function(err) {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                res.json({
                    id: this.lastID,
                    filename: originalname,
                    size: size
                });
            }
        );
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
        } catch (e) {}
        
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
    const { videoId, platformIds } = req.body;
    
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
            
            activeStreams.set(streamKey, {
                process: ffmpeg,
                videoId,
                platformId
            });
            
            // Actualizar scheduler activeStreams
            scheduler.activeStreams.set(streamKey, {
                process: ffmpeg,
                videoId,
                platformId
            });
            
            db.run(
                'INSERT INTO streams (video_id, platform_id, status, process_pid, started_at) VALUES (?, ?, ?, ?, datetime("now"))',
                [videoId, platformId, 'streaming', ffmpeg.pid]
            );
            
            ffmpeg.stderr.on('data', (data) => {
                console.log(`FFmpeg [${streamKey}]: ${data}`);
            });
            
            ffmpeg.on('close', (code) => {
                activeStreams.delete(streamKey);
                scheduler.activeStreams.delete(streamKey);
                db.run(
                    'UPDATE streams SET status = ?, error_message = ? WHERE video_id = ? AND platform_id = ? AND status = "streaming"',
                    [code === 0 ? 'completed' : 'error', code !== 0 ? `Exit code: ${code}` : null, videoId, platformId]
                );
            });
            
            results.push({
                platformId,
                success: true,
                pid: ffmpeg.pid
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
        stream.process.kill('SIGTERM');
        activeStreams.delete(streamKey);
        scheduler.activeStreams.delete(streamKey);
        
        db.run(
            'UPDATE streams SET status = "stopped" WHERE video_id = ? AND platform_id = ? AND status = "streaming"',
            [videoId, platformId]
        );
        
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Stream no encontrado' });
    }
});

app.get('/api/streams/status', (req, res) => {
    const activeStreamsList = [];
    
    activeStreams.forEach((stream, key) => {
        activeStreamsList.push({
            key,
            videoId: stream.videoId,
            platformId: stream.platformId,
            pid: stream.process.pid
        });
    });
    
    res.json({ activeStreams: activeStreamsList });
});

app.get('/api/streams/history', (req, res) => {
    db.all(`
        SELECT s.*, v.original_name as video_name, p.name as platform_name, p.type as platform_type
        FROM streams s
        JOIN videos v ON s.video_id = v.id
        JOIN platforms p ON s.platform_id = p.id
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

// ========== NUEVOS ENDPOINTS PARA PROGRAMACIÓN ==========

// Obtener todas las programaciones
app.get('/api/scheduled-streams', async (req, res) => {
    try {
        const schedules = await scheduler.getAllSchedules();
        
        // Enriquecer con información de plataformas
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

// Crear nueva programación
app.post('/api/scheduled-streams', async (req, res) => {
    try {
        const { videoId, platformIds, scheduleDays, scheduleTime } = req.body;
        
        // Validaciones
        if (!videoId || !platformIds || !scheduleDays || !scheduleTime) {
            return res.status(400).json({ error: 'Faltan campos requeridos' });
        }
        
        if (!Array.isArray(platformIds) || platformIds.length === 0) {
            return res.status(400).json({ error: 'Debe seleccionar al menos una plataforma' });
        }
        
        if (!Array.isArray(scheduleDays) || scheduleDays.length === 0) {
            return res.status(400).json({ error: 'Debe seleccionar al menos un día' });
        }
        
        // Validar formato de hora HH:MM
        const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
        if (!timeRegex.test(scheduleTime)) {
            return res.status(400).json({ error: 'Formato de hora inválido (use HH:MM)' });
        }
        
        const result = await scheduler.createSchedule({
            videoId,
            platformIds,
            scheduleDays,
            scheduleTime
        });
        
        res.json({ success: true, scheduleId: result.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Actualizar programación
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

// Eliminar programación
app.delete('/api/scheduled-streams/:id', async (req, res) => {
    try {
        const scheduleId = parseInt(req.params.id);
        await scheduler.deleteSchedule(scheduleId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Obtener logs de una programación
app.get('/api/scheduled-streams/:id/logs', async (req, res) => {
    try {
        const scheduleId = parseInt(req.params.id);
        const logs = await scheduler.getScheduleLogs(scheduleId);
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Funciones auxiliares existentes
function stopAllStreamsForVideo(videoId) {
    activeStreams.forEach((stream, key) => {
        if (stream.videoId == videoId) {
            stream.process.kill('SIGTERM');
            activeStreams.delete(key);
            scheduler.activeStreams.delete(key);
        }
    });
}

function stopAllStreamsForPlatform(platformId) {
    activeStreams.forEach((stream, key) => {
        if (stream.platformId == platformId) {
            stream.process.kill('SIGTERM');
            activeStreams.delete(key);
            scheduler.activeStreams.delete(key);
        }
    });
}

// Usar server en lugar de app.listen para WebSocket
server.listen(PORT, '0.0.0.0', () => {
    console.log(`StreamHub ejecutándose en http://localhost:${PORT}`);
    console.log('WebSocket disponible para notificaciones en tiempo real');
});
