const EventEmitter = require('events');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

class DropboxService extends EventEmitter {
    constructor(db) {
        super();
        this.db = db;
        this.downloads = new Map();
        this.apiClient = null;
        this.accessToken = null;
        this.refreshToken = null;
    }

    async initialize() {
        await this.loadAPITokens();
        
        // Check token refresh every 30 minutes
        setInterval(() => {
            this.checkAndRefreshToken();
        }, 30 * 60 * 1000);
    }

    async loadAPITokens() {
        return new Promise((resolve) => {
            this.db.get(
                'SELECT * FROM api_tokens WHERE service = ? ORDER BY created_at DESC LIMIT 1',
                ['dropbox'],
                (err, row) => {
                    if (row) {
                        this.accessToken = row.access_token;
                        this.refreshToken = row.refresh_token;
                        
                        if (row.expires_at) {
                            const expiresAt = new Date(row.expires_at);
                            if (expiresAt <= new Date()) {
                                this.refreshTokens();
                            }
                        }
                    }
                    resolve();
                }
            );
        });
    }

    async setupAPI(accessToken, refreshToken = null) {
        this.accessToken = accessToken;
        this.refreshToken = refreshToken;
        
        return new Promise((resolve, reject) => {
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + 4); // Dropbox tokens usually last 4 hours
            
            this.db.run(
                `INSERT OR REPLACE INTO api_tokens (service, access_token, refresh_token, expires_at, updated_at) 
                 VALUES (?, ?, ?, ?, datetime('now'))`,
                ['dropbox', accessToken, refreshToken, expiresAt.toISOString()],
                (err) => {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });
    }

    async refreshTokens() {
        if (!this.refreshToken) {
            console.error('No refresh token available');
            return;
        }

        try {
            const response = await axios.post('https://api.dropboxapi.com/oauth2/token', {
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken,
                client_id: process.env.DROPBOX_CLIENT_ID,
                client_secret: process.env.DROPBOX_CLIENT_SECRET
            });

            const { access_token } = response.data;
            await this.setupAPI(access_token, this.refreshToken);
            
            console.log('Dropbox token refreshed successfully');
        } catch (error) {
            console.error('Failed to refresh Dropbox token:', error);
        }
    }

    async checkAndRefreshToken() {
        const row = await new Promise((resolve) => {
            this.db.get(
                'SELECT * FROM api_tokens WHERE service = ? ORDER BY created_at DESC LIMIT 1',
                ['dropbox'],
                (err, row) => resolve(row)
            );
        });

        if (row && row.expires_at) {
            const expiresAt = new Date(row.expires_at);
            const now = new Date();
            const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);
            
            if (hoursUntilExpiry < 1) {
                await this.refreshTokens();
            }
        }
    }

    convertDropboxUrl(url) {
        // Convert Dropbox URLs to direct download links
        let directUrl = url;
        
        // Handle various Dropbox URL formats
        if (url.includes('dropbox.com')) {
            // Replace dl=0 with dl=1
            if (url.includes('dl=0')) {
                directUrl = url.replace('dl=0', 'dl=1');
            } else if (!url.includes('dl=')) {
                // Add dl=1 if not present
                const separator = url.includes('?') ? '&' : '?';
                directUrl = url + separator + 'dl=1';
            }
            
            // Convert share links to direct download
            if (url.includes('/s/') || url.includes('/sh/')) {
                directUrl = directUrl.replace('www.dropbox.com', 'dl.dropboxusercontent.com');
            }
        }
        
        return directUrl;
    }

    async downloadFromUrl(dropboxUrl, downloadId) {
        const directUrl = this.convertDropboxUrl(dropboxUrl);
        
        // Create download record
        await this.createDownloadRecord(downloadId, dropboxUrl);
        
        const download = {
            id: downloadId,
            url: directUrl,
            originalUrl: dropboxUrl,
            progress: 0,
            size: 0,
            downloadedBytes: 0,
            status: 'starting',
            startTime: Date.now(),
            controller: new AbortController()
        };
        
        this.downloads.set(downloadId, download);
        
        // Start download process
        this.performDownload(download);
        
        return download;
    }

    async performDownload(download) {
        const tempDir = path.join(__dirname, 'temp');
        await fs.promises.mkdir(tempDir, { recursive: true });
        
        const tempFilename = `download_${download.id}_${Date.now()}.tmp`;
        const tempPath = path.join(tempDir, tempFilename);
        const writeStream = fs.createWriteStream(tempPath);
        
        try {
            // Update status
            download.status = 'downloading';
            await this.updateDownloadStatus(download.id, 'downloading');
            
            // Make request with proper headers
            const response = await axios({
                method: 'GET',
                url: download.url,
                responseType: 'stream',
                signal: download.controller.signal,
                headers: {
                    'User-Agent': 'StreamHub/2.0',
                    ...(this.accessToken && { 'Authorization': `Bearer ${this.accessToken}` })
                },
                maxRedirects: 5,
                validateStatus: (status) => status < 400
            });
            
            const contentLength = parseInt(response.headers['content-length'] || '0');
            download.size = contentLength;
            
            // Get filename from headers or URL
            let filename = this.extractFilename(response.headers, download.originalUrl);
            download.filename = filename;
            
            // Progress tracking
            let downloadedBytes = 0;
            response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                download.downloadedBytes = downloadedBytes;
                
                if (contentLength > 0) {
                    download.progress = Math.round((downloadedBytes / contentLength) * 100);
                }
                
                // Emit progress event
                this.emit('download:progress', {
                    downloadId: download.id,
                    progress: download.progress,
                    downloadedBytes,
                    totalBytes: contentLength,
                    speed: this.calculateSpeed(download.startTime, downloadedBytes)
                });
                
                // Update database every 5%
                if (download.progress % 5 === 0) {
                    this.updateDownloadProgress(download.id, download.progress);
                }
            });
            
            // Pipe to file
            await pipeline(response.data, writeStream);
            
            // Move to final location
            const uploadsDir = path.join(__dirname, 'uploads');
            await fs.promises.mkdir(uploadsDir, { recursive: true });
            
            const finalFilename = `${crypto.randomBytes(16).toString('hex')}_${filename}`;
            const finalPath = path.join(uploadsDir, finalFilename);
            
            await fs.promises.rename(tempPath, finalPath);
            
            // Create video record
            const videoId = await this.createVideoRecord(filename, finalPath, contentLength, download.originalUrl);
            
            // Update download record
            download.status = 'completed';
            download.videoId = videoId;
            await this.completeDownload(download.id, videoId);
            
            // Emit completion event
            this.emit('download:complete', {
                downloadId: download.id,
                videoId,
                filename,
                size: contentLength
            });
            
        } catch (error) {
            console.error('Download error:', error);
            
            // Cleanup temp file
            try {
                await fs.promises.unlink(tempPath);
            } catch (e) {}
            
            download.status = 'error';
            download.error = error.message;
            
            await this.failDownload(download.id, error.message);
            
            this.emit('download:error', {
                downloadId: download.id,
                error: error.message
            });
            
            throw error;
        } finally {
            this.downloads.delete(download.id);
        }
    }

    extractFilename(headers, url) {
        // Try to get filename from Content-Disposition header
        const contentDisposition = headers['content-disposition'];
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
            if (filenameMatch && filenameMatch[1]) {
                return filenameMatch[1].replace(/['"]/g, '');
            }
        }
        
        // Extract from URL
        const urlParts = url.split('/');
        const lastPart = urlParts[urlParts.length - 1];
        const filename = lastPart.split('?')[0] || `video_${Date.now()}.mp4`;
        
        return decodeURIComponent(filename);
    }

    calculateSpeed(startTime, downloadedBytes) {
        const elapsedSeconds = (Date.now() - startTime) / 1000;
        const bytesPerSecond = downloadedBytes / elapsedSeconds;
        return this.formatSpeed(bytesPerSecond);
    }

    formatSpeed(bytesPerSecond) {
        if (bytesPerSecond < 1024) {
            return `${bytesPerSecond.toFixed(2)} B/s`;
        } else if (bytesPerSecond < 1024 * 1024) {
            return `${(bytesPerSecond / 1024).toFixed(2)} KB/s`;
        } else {
            return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
        }
    }

    async createDownloadRecord(downloadId, dropboxUrl) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO dropbox_downloads (download_id, dropbox_url, status) VALUES (?, ?, ?)',
                [downloadId, dropboxUrl, 'starting'],
                (err) => {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });
    }

    async updateDownloadStatus(downloadId, status) {
        return new Promise((resolve) => {
            this.db.run(
                'UPDATE dropbox_downloads SET status = ? WHERE download_id = ?',
                [status, downloadId],
                () => resolve()
            );
        });
    }

    async updateDownloadProgress(downloadId, progress) {
        return new Promise((resolve) => {
            this.db.run(
                'UPDATE dropbox_downloads SET progress = ? WHERE download_id = ?',
                [progress, downloadId],
                () => resolve()
            );
        });
    }

    async completeDownload(downloadId, videoId) {
        return new Promise((resolve) => {
            this.db.run(
                'UPDATE dropbox_downloads SET status = ?, progress = 100, video_id = ?, completed_at = datetime("now") WHERE download_id = ?',
                ['completed', videoId, downloadId],
                () => resolve()
            );
        });
    }

    async failDownload(downloadId, errorMessage) {
        return new Promise((resolve) => {
            this.db.run(
                'UPDATE dropbox_downloads SET status = ?, error_message = ? WHERE download_id = ?',
                ['error', errorMessage, downloadId],
                () => resolve()
            );
        });
    }

    async createVideoRecord(filename, filepath, size, dropboxUrl) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO videos (filename, original_name, path, size, source, dropbox_url) VALUES (?, ?, ?, ?, ?, ?)',
                [path.basename(filepath), filename, filepath, size, 'dropbox', dropboxUrl],
                function(err) {
                    if (err) return reject(err);
                    resolve(this.lastID);
                }
            );
        });
    }

    async cancelDownload(downloadId) {
        const download = this.downloads.get(downloadId);
        if (download && download.controller) {
            download.controller.abort();
            download.status = 'cancelled';
            
            await this.updateDownloadStatus(downloadId, 'cancelled');
            this.downloads.delete(downloadId);
        }
    }

    async getDownloadStatus(downloadId) {
        // Check active downloads first
        const activeDownload = this.downloads.get(downloadId);
        if (activeDownload) {
            return {
                id: downloadId,
                status: activeDownload.status,
                progress: activeDownload.progress,
                size: activeDownload.size,
                downloadedBytes: activeDownload.downloadedBytes,
                filename: activeDownload.filename,
                speed: this.calculateSpeed(activeDownload.startTime, activeDownload.downloadedBytes)
            };
        }
        
        // Check database
        return new Promise((resolve) => {
            this.db.get(
                'SELECT * FROM dropbox_downloads WHERE download_id = ?',
                [downloadId],
                (err, row) => {
                    if (err || !row) {
                        resolve(null);
                        return;
                    }
                    resolve(row);
                }
            );
        });
    }

    async getAPIStatus() {
        return {
            configured: !!this.accessToken,
            hasRefreshToken: !!this.refreshToken,
            canAutoRefresh: !!(this.refreshToken && process.env.DROPBOX_CLIENT_ID && process.env.DROPBOX_CLIENT_SECRET)
        };
    }
}

module.exports = DropboxService;
