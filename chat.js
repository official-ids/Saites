const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const { kv } = require('@vercel/kv');

const router = express.Router();

router.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
}));

router.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

router.use(express.json({ limit: '1mb' }));

const ROOM_TTL = 24 * 60 * 60 * 1000;
const ROOM_CLEANUP_INTERVAL = 30 * 60 * 1000;
const ROOM_CODE_LENGTH = 8;
const MAX_ROOM_CODE_ATTEMPTS = 10;
const MAX_MESSAGES_PER_ROOM = 1000;
const MESSAGE_TTL = 7 * 24 * 60 * 60 * 1000;

const activeRooms = new Map();

class RoomManager {
    constructor() {
        this.rooms = new Map();
        this.startCleanupInterval();
    }

    generateRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let result = '';
        for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    createRoom(code = null) {
        let roomCode = code;
        let attempts = 0;
        
        if (!roomCode) {
            do {
                roomCode = this.generateRoomCode();
                attempts++;
                if (attempts > MAX_ROOM_CODE_ATTEMPTS) {
                    return null;
                }
            } while (this.rooms.has(roomCode));
        } else {
            if (this.rooms.has(roomCode)) {
                return null;
            }
        }

        const room = {
            code: roomCode,
            createdAt: Date.now(),
            expiresAt: Date.now() + ROOM_TTL,
            participants: new Set(),
            messages: []
        };

        this.rooms.set(roomCode, room);
        return room;
    }

    getRoom(code) {
        return this.rooms.get(code) || null;
    }

    roomExists(code) {
        return this.rooms.has(code);
    }

    addParticipant(code, userId) {
        const room = this.rooms.get(code);
        if (!room) return false;
        
        room.participants.add(userId);
        return true;
    }

    removeParticipant(code, userId) {
        const room = this.rooms.get(code);
        if (!room) return false;
        
        room.participants.delete(userId);
        
        if (room.participants.size === 0) {
            this.rooms.delete(code);
        }
        
        return true;
    }

    addMessage(code, message) {
        const room = this.rooms.get(code);
        if (!room) return false;
        
        room.messages.push({
            ...message,
            timestamp: Date.now()
        });
        
        if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
            room.messages = room.messages.slice(-MAX_MESSAGES_PER_ROOM);
        }
        
        return true;
    }

    getMessages(code, limit = 50) {
        const room = this.rooms.get(code);
        if (!room) return [];
        
        return room.messages.slice(-limit);
    }

    cleanupExpiredRooms() {
        const now = Date.now();
        for (const [code, room] of this.rooms.entries()) {
            if (now > room.expiresAt) {
                this.rooms.delete(code);
            }
        }
    }

    startCleanupInterval() {
        setInterval(() => {
            this.cleanupExpiredRooms();
        }, ROOM_CLEANUP_INTERVAL);
    }
}

const roomManager = new RoomManager();

const isValidRoomCode = (code) => {
    return code && /^[A-Z0-9]{8}$/.test(code.toUpperCase());
};

const normalizeRoomCode = (code) => {
    return code ? code.toUpperCase() : '';
};

router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: Date.now(),
        version: '1.0.0'
    });
});

router.post('/room', (req, res) => {
    try {
        const { code } = req.body;
        
        const room = roomManager.createRoom(code);
        
        if (!room) {
            return res.status(400).json({
                error: 'Не удалось создать комнату. Код уже используется.'
            });
        }

        res.json({
            success: true,
            code: room.code,
            expiresAt: room.expiresAt
        });
    } catch (err) {
        console.error('[chat/room/create]', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/room/:code', (req, res) => {
    try {
        const code = normalizeRoomCode(req.params.code);
        
        if (!isValidRoomCode(code)) {
            return res.status(400).json({ error: 'Invalid room code' });
        }
        
        const room = roomManager.getRoom(code);
        
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }
        
        res.json({
            exists: true,
            code: room.code,
            participants: room.participants.size,
            createdAt: room.createdAt,
            expiresAt: room.expiresAt
        });
    } catch (err) {
        console.error('[chat/room/get]', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/room/:code/join', (req, res) => {
    try {
        const code = normalizeRoomCode(req.params.code);
        const { userId } = req.body;
        
        if (!isValidRoomCode(code)) {
            return res.status(400).json({ error: 'Invalid room code' });
        }
        
        if (!userId) {
            return res.status(400).json({ error: 'userId required' });
        }
        
        const room = roomManager.getRoom(code);
        
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }
        
        const added = roomManager.addParticipant(code, userId);
        
        if (!added) {
            return res.status(400).json({ error: 'Failed to join room' });
        }
        
        res.json({
            success: true,
            code: room.code,
            participants: room.participants.size
        });
    } catch (err) {
        console.error('[chat/room/join]', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/room/:code/leave', (req, res) => {
    try {
        const code = normalizeRoomCode(req.params.code);
        const { userId } = req.body;
        
        if (!isValidRoomCode(code)) {
            return res.status(400).json({ error: 'Invalid room code' });
        }
        
        if (!userId) {
            return res.status(400).json({ error: 'userId required' });
        }
        
        const removed = roomManager.removeParticipant(code, userId);
        
        if (!removed) {
            return res.status(404).json({ error: 'Room not found' });
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('[chat/room/leave]', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/room/:code/message', (req, res) => {
    try {
        const code = normalizeRoomCode(req.params.code);
        const { userId, username, text } = req.body;
        
        if (!isValidRoomCode(code)) {
            return res.status(400).json({ error: 'Invalid room code' });
        }
        
        if (!userId || !username || !text) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const room = roomManager.getRoom(code);
        
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }
        
        if (!room.participants.has(userId)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        
        const message = {
            id: crypto.randomBytes(8).toString('hex'),
            userId,
            username,
            text: text.slice(0, 2000)
        };
        
        const added = roomManager.addMessage(code, message);
        
        if (!added) {
            return res.status(400).json({ error: 'Failed to add message' });
        }
        
        res.json({
            success: true,
            message
        });
    } catch (err) {
        console.error('[chat/message/send]', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/room/:code/messages', (req, res) => {
    try {
        const code = normalizeRoomCode(req.params.code);
        const limit = parseInt(req.query.limit) || 50;
        
        if (!isValidRoomCode(code)) {
            return res.status(400).json({ error: 'Invalid room code' });
        }
        
        const messages = roomManager.getMessages(code, limit);
        
        res.json({
            messages,
            total: messages.length
        });
    } catch (err) {
        console.error('[chat/messages/get]', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/room/:code/participants', (req, res) => {
    try {
        const code = normalizeRoomCode(req.params.code);
        
        if (!isValidRoomCode(code)) {
            return res.status(400).json({ error: 'Invalid room code' });
        }
        
        const room = roomManager.getRoom(code);
        
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }
        
        res.json({
            participants: room.participants.size,
            participantList: Array.from(room.participants)
        });
    } catch (err) {
        console.error('[chat/participants/get]', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.use((err, req, res, next) => {
    console.error('[chat error]', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error'
    });
});

module.exports = router;