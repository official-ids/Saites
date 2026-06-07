const { PeerServer } = require('peer');

const port = process.env.PORT || 9000;

const peerServer = PeerServer({
    port: port,
    path: '/peerjs',
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization']
    },
    config: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ]
    }
});

peerServer.on('connection', (client) => {
    console.log(`[Peer] Connected: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
    console.log(`[Peer] Disconnected: ${client.getId()}`);
});

console.log(`[Peer] Server running on port ${port}, path /peerjs`);