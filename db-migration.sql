-- StreamHub Database Migration Script
-- Version 2.0 - Dropbox Integration

-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- Add new columns to videos table if they don't exist
ALTER TABLE videos ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'local';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS dropbox_url TEXT;

-- Create dropbox_downloads table
CREATE TABLE IF NOT EXISTS dropbox_downloads (
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
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

-- Create api_tokens table
CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create scheduled_streams table if not exists
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
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

-- Create schedule_logs table if not exists
CREATE TABLE IF NOT EXISTS schedule_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scheduled_stream_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scheduled_stream_id) REFERENCES scheduled_streams(id) ON DELETE CASCADE
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_downloads_status ON dropbox_downloads(status);
CREATE INDEX IF NOT EXISTS idx_downloads_download_id ON dropbox_downloads(download_id);
CREATE INDEX IF NOT EXISTS idx_videos_source ON videos(source);
CREATE INDEX IF NOT EXISTS idx_videos_uploaded_at ON videos(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_streams_started_at ON streams(started_at);
CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_streams_active ON scheduled_streams(is_active);
CREATE INDEX IF NOT EXISTS idx_scheduled_streams_next_run ON scheduled_streams(next_run);
CREATE INDEX IF NOT EXISTS idx_api_tokens_service ON api_tokens(service);

-- Create triggers for updated_at
CREATE TRIGGER IF NOT EXISTS update_api_tokens_timestamp 
AFTER UPDATE ON api_tokens
BEGIN
    UPDATE api_tokens SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Views for easier querying
CREATE VIEW IF NOT EXISTS active_downloads AS
SELECT 
    d.*,
    v.original_name as video_name
FROM dropbox_downloads d
LEFT JOIN videos v ON d.video_id = v.id
WHERE d.status IN ('pending', 'downloading', 'starting');

CREATE VIEW IF NOT EXISTS recent_streams AS
SELECT 
    s.*,
    v.original_name as video_name,
    p.name as platform_name,
    p.type as platform_type
FROM streams s
JOIN videos v ON s.video_id = v.id
JOIN platforms p ON s.platform_id = p.id
ORDER BY s.started_at DESC
LIMIT 100;

CREATE VIEW IF NOT EXISTS upcoming_schedules AS
SELECT 
    ss.*,
    v.original_name as video_name
FROM scheduled_streams ss
JOIN videos v ON ss.video_id = v.id
WHERE ss.is_active = 1
ORDER BY ss.next_run ASC;

-- Migration data integrity checks
-- Check for orphaned streams
DELETE FROM streams WHERE video_id NOT IN (SELECT id FROM videos);
DELETE FROM streams WHERE platform_id NOT IN (SELECT id FROM platforms);

-- Check for orphaned scheduled streams
DELETE FROM scheduled_streams WHERE video_id NOT IN (SELECT id FROM videos);

-- Add sample data for testing (optional - comment out in production)
-- INSERT INTO api_tokens (service, access_token, refresh_token, expires_at) 
-- VALUES ('dropbox', 'sample_token', 'sample_refresh', datetime('now', '+4 hours'));

-- Vacuum to optimize database
VACUUM;

-- Analyze to update statistics
ANALYZE;
