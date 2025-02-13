import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../config';
import path from 'path';
import fs from 'fs';

interface QBitTorrent {
    hash: string;
    name: string;
    magnet_uri: string;
    progress: number;
    dlspeed: number;
    size: number;
    state: string;
    content_path: string;
    save_path: string;
    num_seeds: number;
    num_leechs: number;
    added_on: number;
    completion_on: number;
    category: string;
    tags: string;
}

class QBittorrentService {
    private baseUrl: string;
    private isLoggedIn: boolean = false;
    private axiosInstance: AxiosInstance;

    constructor() {
        this.baseUrl = `http://${config.QBITTORRENT_HOST}:${config.QBITTORRENT_PORT}`;
        console.log('QBittorrent WebUI URL:', this.baseUrl);
        
        this.axiosInstance = axios.create({
            baseURL: this.baseUrl,
            withCredentials: true,
            headers: {
                'Referer': this.baseUrl
            }
        });
    }

    async login(): Promise<void> {
        if (this.isLoggedIn) return;

        try {
            console.log('Attempting to login to QBittorrent WebUI...');
            const params = new URLSearchParams();
            params.append('username', config.QBITTORRENT_USERNAME);
            params.append('password', config.QBITTORRENT_PASSWORD);

            const response = await this.axiosInstance.post('/api/v2/auth/login', params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            if (response.data === 'Ok.' || response.status === 200) {
                this.isLoggedIn = true;
                console.log('Successfully logged in to QBittorrent WebUI');
                
                // Store the cookie for subsequent requests
                const cookie = response.headers['set-cookie'];
                if (cookie) {
                    this.axiosInstance.defaults.headers.Cookie = cookie[0];
                    console.log('Session cookie stored');
                }
            } else {
                throw new Error('Login failed: Unexpected response');
            }
        } catch (error) {
            if (error instanceof AxiosError) {
                console.error('Failed to login to qBittorrent:', {
                    status: error.response?.status,
                    statusText: error.response?.statusText,
                    data: error.response?.data,
                    message: error.message
                });
                throw new Error(`Login failed: ${error.message} (${error.response?.status || 'unknown status'})`);
            }
            throw error;
        }
    }

    async addMagnet(magnetUrl: string): Promise<void> {
        await this.ensureLoggedIn();
        try {
            console.log('Adding magnet URL to QBittorrent...');
            const params = new URLSearchParams();
            params.append('urls', magnetUrl);
            
            // According to API docs, savepath should be absolute
            if (config.QBITTORRENT_DOWNLOAD_PATH) {
                const savePath = path.resolve(config.QBITTORRENT_DOWNLOAD_PATH);
                console.log('Using save path:', savePath);
                params.append('savepath', savePath);
            }

            // Optional parameters for better control
            params.append('paused', 'false');
            params.append('skip_checking', 'false');
            params.append('root_folder', 'true');
            params.append('sequentialDownload', 'true'); // For streaming-friendly download
            params.append('firstLastPiecePrio', 'true'); // For faster preview

            const response = await this.axiosInstance.post('/api/v2/torrents/add', params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            // According to the API docs, if there's no error thrown, the torrent was added successfully
            if (response.status === 200) {
                console.log('Magnet URL successfully added');
                // Wait a bit for qBittorrent to process the magnet
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
                throw new Error(`Failed to add magnet: Unexpected response status ${response.status}`);
            }
        } catch (error) {
            if (error instanceof AxiosError) {
                if (error.response?.status === 403) {
                    // If we get a 403, our session might have expired
                    console.log('Session expired, attempting to login again...');
                    this.isLoggedIn = false;
                    await this.login();
                    return this.addMagnet(magnetUrl);
                }
                console.error('Failed to add magnet:', {
                    status: error.response?.status,
                    statusText: error.response?.statusText,
                    data: error.response?.data,
                    message: error.message
                });
                throw new Error(`Failed to add magnet: ${error.message} (${error.response?.status || 'unknown status'})`);
            }
            throw error;
        }
    }

    async getTorrents(filter: string = 'all'): Promise<QBitTorrent[]> {
        await this.ensureLoggedIn();
        try {
            const params = new URLSearchParams({
                filter,
                sort: 'added_on',
                reverse: 'true'
            });

            const response = await this.axiosInstance.get(`/api/v2/torrents/info?${params}`);
            return response.data;
        } catch (error) {
            if ((error as AxiosError)?.response?.status === 403) {
                // If we get a 403, our session might have expired
                this.isLoggedIn = false;
                await this.login();
                return this.getTorrents(filter);
            }
            console.error('Failed to get torrents:', error);
            throw error;
        }
    }

    async deleteTorrent(hash: string, deleteFiles: boolean = true): Promise<void> {
        await this.ensureLoggedIn();
        try {
            const params = new URLSearchParams();
            params.append('hashes', hash);
            params.append('deleteFiles', deleteFiles.toString());

            await this.axiosInstance.post('/api/v2/torrents/delete', params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
        } catch (error) {
            if ((error as AxiosError)?.response?.status === 403) {
                // If we get a 403, our session might have expired
                this.isLoggedIn = false;
                await this.login();
                return this.deleteTorrent(hash, deleteFiles);
            }
            console.error('Failed to delete torrent:', error);
            throw error;
        }
    }

    async pauseTorrent(hash: string): Promise<void> {
        await this.ensureLoggedIn();
        try {
            const params = new URLSearchParams();
            params.append('hashes', hash);

            await this.axiosInstance.post('/api/v2/torrents/pause', params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
        } catch (error) {
            if ((error as AxiosError)?.response?.status === 403) {
                // If we get a 403, our session might have expired
                this.isLoggedIn = false;
                await this.login();
                return this.pauseTorrent(hash);
            }
            console.error('Failed to pause torrent:', error);
            throw error;
        }
    }

    async resumeTorrent(hash: string): Promise<void> {
        await this.ensureLoggedIn();
        try {
            const params = new URLSearchParams();
            params.append('hashes', hash);

            await this.axiosInstance.post('/api/v2/torrents/resume', params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
        } catch (error) {
            if ((error as AxiosError)?.response?.status === 403) {
                // If we get a 403, our session might have expired
                this.isLoggedIn = false;
                await this.login();
                return this.resumeTorrent(hash);
            }
            console.error('Failed to resume torrent:', error);
            throw error;
        }
    }

    async getFiles(hash: string): Promise<{ name: string; size: number; progress: number; availability: number; url: string; }[]> {
        await this.ensureLoggedIn();
        try {
            console.log('Getting file information from QBittorrent...');
            const response = await this.axiosInstance.get('/api/v2/torrents/files', {
                params: { hash }
            });
            
            // Map the files and create download URLs with proper encoding
            return response.data.map((file: any) => ({
                ...file,
                url: `${this.baseUrl}/downloads/${encodeURIComponent(file.name)}`
            }));
        } catch (error) {
            if ((error as AxiosError)?.response?.status === 403) {
                this.isLoggedIn = false;
                await this.login();
                return this.getFiles(hash);
            }
            console.error('Failed to get files:', error);
            throw error;
        }
    }

    async downloadFile(hash: string): Promise<{ path: string; filename: string }> {
        try {
            await this.ensureLoggedIn();
            
            // Get torrent info
            const torrents = await this.getTorrents();
            const torrent = torrents.find(t => t.hash === hash);
            if (!torrent) {
                throw new Error('Torrent not found');
            }

            // Get file list
            const files = await this.getFiles(hash);
            if (!files || files.length === 0) {
                throw new Error('No files found in torrent');
            }

            // For now, we'll handle the first file
            const file = files[0];
            console.log('Getting file:', file.name);

            // Try different possible paths
            const possiblePaths = [
                path.join(torrent.save_path, torrent.name, file.name),
                path.join(torrent.save_path, file.name),
                torrent.content_path,
                path.join(torrent.save_path, path.basename(file.name))
            ].filter(Boolean); // Remove undefined/null paths

            console.log('Trying possible paths:', possiblePaths);

            // Find the first path that exists
            let sourceFilePath: string | undefined;
            for (const testPath of possiblePaths) {
                if (fs.existsSync(testPath)) {
                    sourceFilePath = testPath;
                    break;
                }
            }

            if (!sourceFilePath) {
                throw new Error(`File not found. Tried paths: ${possiblePaths.join(', ')}`);
            }

            console.log('Found file at:', sourceFilePath);

            // Create sanitized filename for display/reference
            const sanitizedName = path.basename(file.name)
                .replace(/[<>:"/\\|?*]/g, '_')
                .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
                .trim();

            // Return the actual file path and sanitized name
            return {
                path: sourceFilePath,
                filename: sanitizedName
            };
        } catch (error) {
            console.error('Failed to get file:', error);
            throw error;
        }
    }

    private async ensureLoggedIn(): Promise<void> {
        if (!this.isLoggedIn) {
            await this.login();
        }
    }
}

export const qbittorrent = new QBittorrentService(); 