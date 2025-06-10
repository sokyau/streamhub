const EventEmitter = require('events');
const path = require('path');
const fs = require('fs').promises;

class LoopManager extends EventEmitter {
    constructor(db) {
        super();
        this.db = db;
        this.activeLoops = new Map();
    }

    async initialize() {
        await this.createTables();
    }

    async createTables() {
        const createLoopConfigTable = `
            CREATE TABLE IF NOT EXISTS loop_configurations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                type TEXT NOT NULL,
                video_ids TEXT NOT NULL,
                duration_hours INTEGER,
                repeat_count INTEGER,
                infinite BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;

        const createLoopSessionsTable = `
            CREATE TABLE IF NOT EXISTS loop_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                config_id INTEGER,
                stream_id INTEGER,
                started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                ended_at DATETIME,
                current_iteration INTEGER DEFAULT 0,
                status TEXT DEFAULT 'active',
                FOREIGN KEY (config_id) REFERENCES loop_configurations(id),
                FOREIGN KEY (stream_id) REFERENCES streams(id)
            )
        `;

        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run(createLoopConfigTable);
                this.db.run(createLoopSessionsTable, resolve);
            });
        });
    }

    async createLoopConfig(config) {
        const { name, type, videoIds, durationHours, repeatCount, infinite } = config;
        
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO loop_configurations (name, type, video_ids, duration_hours, repeat_count, infinite) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [name, type, JSON.stringify(videoIds), durationHours, repeatCount, infinite ? 1 : 0],
                function(err) {
                    if (err) return reject(err);
                    resolve({ id: this.lastID });
                }
            );
        });
    }

    async startLoopSession(configId, streamId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO loop_sessions (config_id, stream_id) VALUES (?, ?)',
                [configId, streamId],
                function(err) {
                    if (err) return reject(err);
                    
                    const sessionId = this.lastID;
                    this.activeLoops.set(streamId, {
                        sessionId,
                        configId,
                        startTime: Date.now(),
                        iteration: 0
                    });
                    
                    resolve({ sessionId });
                }
            );
        });
    }

    async updateLoopIteration(streamId) {
        const loop = this.activeLoops.get(streamId);
        if (!loop) return;

        loop.iteration++;
        
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE loop_sessions SET current_iteration = ? WHERE id = ?',
                [loop.iteration, loop.sessionId],
                resolve
            );
        });
    }

    async shouldContinueLoop(streamId) {
        const loop = this.activeLoops.get(streamId);
        if (!loop) return false;

        const config = await this.getLoopConfig(loop.configId);
        if (!config) return false;

        if (config.infinite) return true;

        if (config.repeat_count && loop.iteration >= config.repeat_count) {
            return false;
        }

        if (config.duration_hours) {
            const elapsedHours = (Date.now() - loop.startTime) / (1000 * 60 * 60);
            if (elapsedHours >= config.duration_hours) {
                return false;
            }
        }

        return true;
    }

    async endLoopSession(streamId) {
        const loop = this.activeLoops.get(streamId);
        if (!loop) return;

        this.activeLoops.delete(streamId);

        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE loop_sessions SET ended_at = datetime("now"), status = "completed" WHERE id = ?',
                [loop.sessionId],
                resolve
            );
        });
    }

    async getLoopConfig(configId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM loop_configurations WHERE id = ?',
                [configId],
                (err, row) => {
                    if (err) return reject(err);
                    if (row && row.video_ids) {
                        row.video_ids = JSON.parse(row.video_ids);
                    }
                    resolve(row);
                }
            );
        });
    }

    async getActiveLoops() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT ls.*, lc.name, lc.type, lc.infinite, lc.repeat_count, lc.duration_hours
                 FROM loop_sessions ls
                 JOIN loop_configurations lc ON ls.config_id = lc.id
                 WHERE ls.status = 'active'`,
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });
    }

    async validateVideoFiles(videoIds) {
        const videos = await new Promise((resolve, reject) => {
            const placeholders = videoIds.map(() => '?').join(',');
            this.db.all(
                `SELECT * FROM videos WHERE id IN (${placeholders})`,
                videoIds,
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });

        for (const video of videos) {
            try {
                await fs.access(video.path);
            } catch (error) {
                throw new Error(`Video file not found: ${video.path}`);
            }
        }

        return videos;
    }
}

module.exports = LoopManager;
