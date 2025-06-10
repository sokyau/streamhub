const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class FFmpegLoopBuilder {
    constructor() {
        this.tempDir = path.join(__dirname, 'temp');
    }

    async createLoopCommand(videos, options = {}) {
        const { infinite = false, outputUrl } = options;
        
        if (videos.length === 1 && infinite) {
            return this.createInfiniteLoopCommand(videos[0], outputUrl);
        } else {
            return this.createPlaylistLoopCommand(videos, options);
        }
    }

    createInfiniteLoopCommand(video, outputUrl) {
        return [
            '-stream_loop', '-1',
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
            outputUrl
        ];
    }

    async createPlaylistLoopCommand(videos, options) {
        const { outputUrl, infinite = false, repeatCount = 1 } = options;
        
        const playlistPath = await this.createPlaylist(videos, infinite ? -1 : repeatCount);
        
        return [
            '-f', 'concat',
            '-safe', '0',
            '-re',
            '-i', playlistPath,
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
            outputUrl
        ];
    }

    async createPlaylist(videos, loopCount = 1) {
        await fs.mkdir(this.tempDir, { recursive: true });
        
        const playlistId = uuidv4();
        const playlistPath = path.join(this.tempDir, `playlist_${playlistId}.txt`);
        
        let content = '';
        const iterations = loopCount === -1 ? 1 : loopCount;
        
        for (let i = 0; i < iterations; i++) {
            for (const video of videos) {
                content += `file '${video.path.replace(/'/g, "'\\''")}'` + '\n';
            }
        }
        
        if (loopCount === -1) {
            content += `file '${playlistPath}'` + '\n';
        }
        
        await fs.writeFile(playlistPath, content);
        
        return playlistPath;
    }

    async cleanupPlaylist(playlistPath) {
        try {
            await fs.unlink(playlistPath);
        } catch (error) {
            console.error('Error cleaning up playlist:', error);
        }
    }

    buildFilterComplex(videos) {
        let filterComplex = '';
        let concatInputs = '';
        
        for (let i = 0; i < videos.length; i++) {
            filterComplex += `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];`;
            filterComplex += `[${i}:a]aresample=44100[a${i}];`;
            concatInputs += `[v${i}][a${i}]`;
        }
        
        filterComplex += `${concatInputs}concat=n=${videos.length}:v=1:a=1[outv][outa]`;
        
        return filterComplex;
    }
}

module.exports = FFmpegLoopBuilder;
