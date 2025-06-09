require('dotenv').config();

module.exports = {
    // Server configuration
    server: {
        port: process.env.PORT || 3000,
        host: process.env.HOST || '0.0.0.0'
    },
    
    // Database
    database: {
        path: process.env.DB_PATH || './db/streamhub.db'
    },
    
    // Dropbox configuration
    dropbox: {
        clientId: process.env.DROPBOX_CLIENT_ID,
        clientSecret: process.env.DROPBOX_CLIENT_SECRET,
        redirectUri: process.env.DROPBOX_REDIRECT_URI || 'http://localhost:3000/auth/dropbox/callback'
    },
    
    // Streaming configuration
    streaming: {
        ffmpeg: {
            preset: process.env.FFMPEG_PRESET || 'veryfast',
            videoBitrate: process.env.VIDEO_BITRATE || '3000k',
            audioBitrate: process.env.AUDIO_BITRATE || '160k',
            audioSampleRate: process.env.AUDIO_SAMPLE_RATE || '44100',
            bufferSize: process.env.BUFFER_SIZE || '6000k'
        }
    },
    
    // File handling
    files: {
        uploadDir: process.env.UPLOAD_DIR || './uploads',
        tempDir: process.env.TEMP_DIR || './temp',
        maxFileSize: process.env.MAX_FILE_SIZE || '50GB',
        allowedFormats: ['mp4', 'avi', 'mkv', 'mov', 'flv', 'wmv', 'webm']
    },
    
    // Security
    security: {
        jwtSecret: process.env.JWT_SECRET || 'change-this-secret-in-production',
        bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS) || 10,
        sessionTimeout: process.env.SESSION_TIMEOUT || '24h'
    },
    
    // Logging
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        logDir: process.env.LOG_DIR || './logs'
    },
    
    // Rate limiting
    rateLimiting: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000,
        maxRequests: parseInt(process.env.RATE_LIMIT_MAX) || 100
    }
};
