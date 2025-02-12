import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../config';

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
            
            if (config.QBITTORRENT_DOWNLOAD_PATH) {
                params.append('savepath', config.QBITTORRENT_DOWNLOAD_PATH);
            }

            // Optional parameters for better control
            params.append('paused', 'false');
            params.append('skip_checking', 'false');
            params.append('root_folder', 'true');

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

    private async ensureLoggedIn(): Promise<void> {
        if (!this.isLoggedIn) {
            await this.login();
        }
    }
}

export const qbittorrent = new QBittorrentService(); 