declare module 'qbittorrent-api' {
    interface QBittorrentConfig {
        host: string;
        port: number;
        username: string;
        password: string;
    }

    interface QBitTorrent {
        hash: string;
        name: string;
        magnet_uri: string;
        progress: number;
        dlspeed: number;
        size: number;
    }

    class QBittorrent {
        constructor(config: QBittorrentConfig);
        login(): Promise<void>;
        addMagnet(magnetUrl: string): Promise<void>;
        getTorrents(): Promise<QBitTorrent[]>;
        deleteTorrent(hash: string, deleteFiles: boolean): Promise<void>;
    }

    export = QBittorrent;
} 