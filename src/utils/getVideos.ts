import fs from 'fs';
import path from 'path';

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm'];

export interface VideoInfo {
    name: string;
    path: string;
    size: string;
}

export function getVideosFromDirectory(dirPath: string): VideoInfo[] {
    try {
        const files = fs.readdirSync(dirPath);
        const videos: VideoInfo[] = [];

        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = fs.statSync(filePath);

            if (stats.isFile() && VIDEO_EXTENSIONS.includes(path.extname(file).toLowerCase())) {
                const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
                videos.push({
                    name: file,
                    path: filePath,
                    size: `${sizeInMB} MB`
                });
            }
        }

        return videos;
    } catch (error) {
        console.error('Error reading videos directory:', error);
        return [];
    }
}