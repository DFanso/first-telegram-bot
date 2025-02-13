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

            // Construct source file path
            let sourceFilePath = path.join(torrent.save_path, file.name);
            console.log('Local qBittorrent path:', torrent.save_path);
            console.log('Network file path:', sourceFilePath);

            // Check if file exists at the source path
            if (!fs.existsSync(sourceFilePath)) {
                // Try alternative path construction
                const altSourceFilePath = path.join(torrent.save_path, path.basename(file.name));
                console.log('Trying alternative path:', altSourceFilePath);
                
                if (!fs.existsSync(altSourceFilePath)) {
                    throw new Error(`File not found at network path: ${sourceFilePath} or ${altSourceFilePath}`);
                }
                
                sourceFilePath = altSourceFilePath;
            }

            // Create temp directory if it doesn't exist
            const tempDir = path.join(process.cwd(), 'temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            // Create a temp file path that preserves the directory structure
            const relativePath = path.relative(torrent.save_path, sourceFilePath);
            const tempFilePath = path.join(tempDir, relativePath);
            console.log('Temp file path:', tempFilePath);

            // Ensure the temp directory for this file exists
            const tempFileDir = path.dirname(tempFilePath);
            if (!fs.existsSync(tempFileDir)) {
                fs.mkdirSync(tempFileDir, { recursive: true });
            }

            // Copy file to temp directory using streams for better handling
            try {
                await new Promise<void>((resolve, reject) => {
                    const readStream = fs.createReadStream(sourceFilePath);
                    const writeStream = fs.createWriteStream(tempFilePath);

                    readStream.on('error', (error) => {
                        reject(new Error(`Failed to read file: ${error.message}`));
                    });

                    writeStream.on('error', (error) => {
                        reject(new Error(`Failed to write file: ${error.message}`));
                    });

                    writeStream.on('close', () => {
                        resolve();
                    });

                    readStream.pipe(writeStream);
                });
            } catch (error) {
                if (error instanceof Error) {
                    console.error('Copy error details:', {
                        message: error.message,
                        code: (error as any).code,
                        errno: (error as any).errno
                    });
                    throw new Error(`Failed to copy file: ${error.message} (${(error as any).code})`);
                }
                throw error;
            }
            
            return {
                path: tempFilePath,
                filename: file.name
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