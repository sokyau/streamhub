-- db-migration-fixed.sql - Compatible con SQLite antiguo
-- Crear backup de videos existentes
CREATE TABLE IF NOT EXISTS videos_backup AS SELECT * FROM videos;

-- Crear nueva tabla videos con columnas adicionales
CREATE TABLE IF NOT EXISTS videos_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    source TEXT DEFAULT 'local',
    dropbox_url TEXT,
    download_progress INTEGER DEFAULT 0,
    download_status TEXT DEFAULT 'completed'
);

-- Copiar datos existentes
INSERT INTO videos_new (id, filename, original_name, path, size, uploaded_at, source)
SELECT id, filename, original_name, path, size, uploaded_at, 'local' FROM videos;

-- Eliminar tabla antigua y renombrar
DROP TABLE videos;
ALTER TABLE videos_new RENAME TO videos;

-- Crear tabla para descargas de Dropbox
CREATE TABLE IF NOT EXISTS dropbox_downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id TEXT UNIQUE NOT NULL,
    url TEXT NOT NULL,
    filename TEXT,
    file_size INTEGER,
    downloaded_bytes INTEGER DEFAULT 0,
    progress INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);

-- Crear tabla para tokens de API
CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Crear tabla para streams si no existe
CREATE TABLE IF NOT EXISTS streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER,
    platform_id INTEGER,
    status TEXT DEFAULT 'stopped',
    process_pid INTEGER,
    started_at DATETIME,
    stopped_at DATETIME,
    error_message TEXT,
    FOREIGN KEY (video_id) REFERENCES videos (id),
    FOREIGN KEY (platform_id) REFERENCES platforms (id)
);

-- Crear tabla para plataformas si no existe
CREATE TABLE IF NOT EXISTS platforms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    rtmp_url TEXT NOT NULL,
    stream_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Crear índices
CREATE INDEX IF NOT EXISTS idx_videos_source ON videos(source);
CREATE INDEX IF NOT EXISTS idx_dropbox_downloads_status ON dropbox_downloads(status);
CREATE INDEX IF NOT EXISTS idx_dropbox_downloads_download_id ON dropbox_downloads(download_id);
CREATE INDEX IF NOT EXISTS idx_streams_video_id ON streams(video_id);
CREATE INDEX IF NOT EXISTS idx_streams_platform_id ON streams(platform_id);

-- Verificar estructura
.schema videos
.schema dropbox_downloads
