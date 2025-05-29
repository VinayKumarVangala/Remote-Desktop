const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/build')));

// Store active connections
const connections = new Map();
const rooms = new Map();

// Connection tracking
class ConnectionManager {
  constructor() {
    this.connections = new Map();
    this.rooms = new Map();
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      totalRooms: 0,
      dataTransferred: 0
    };
  }

  addConnection(id, ws) {
    const connectionData = {
      id,
      ws,
      joinedAt: new Date(),
      lastActivity: new Date(),
      isHost: false,
      roomId: null,
      stats: {
        messagesSent: 0,
        messagesReceived: 0,
        bytesTransferred: 0
      }
    };
    
    this.connections.set(id, connectionData);
    this.stats.totalConnections++;
    this.stats.activeConnections++;
    
    console.log(`✅ Connection ${id} added. Active: ${this.stats.activeConnections}`);
    return connectionData;
  }

  removeConnection(id) {
    const connection = this.connections.get(id);
    if (connection) {
      // Leave room if in one
      if (connection.roomId) {
        this.leaveRoom(id, connection.roomId);
      }
      
      this.connections.delete(id);
      this.stats.activeConnections--;
      console.log(`❌ Connection ${id} removed. Active: ${this.stats.activeConnections}`);
      return connection;
    }
    return null;
  }

  getConnection(id) {
    return this.connections.get(id);
  }

  createRoom(hostId) {
    const roomId = crypto.randomBytes(4).toString('hex').toUpperCase();
    const room = {
      id: roomId,
      hostId,
      participants: new Set([hostId]),
      createdAt: new Date(),
      settings: {
        allowFileTransfer: true,
        allowRemoteControl: true,
        maxParticipants: 2
      }
    };
    
    this.rooms.set(roomId, room);
    this.stats.totalRooms++;
    
    const hostConnection = this.connections.get(hostId);
    if (hostConnection) {
      hostConnection.isHost = true;
      hostConnection.roomId = roomId;
    }
    
    console.log(`🏠 Room ${roomId} created by ${hostId}`);
    return room;
  }

  joinRoom(userId, roomId) {
    const room = this.rooms.get(roomId);
    const user = this.connections.get(userId);
    
    if (!room || !user) {
      return { success: false, error: 'Room or user not found' };
    }
    
    if (room.participants.size >= room.settings.maxParticipants) {
      return { success: false, error: 'Room is full' };
    }
    
    room.participants.add(userId);
    user.roomId = roomId;
    
    console.log(`👥 User ${userId} joined room ${roomId}`);
    return { success: true, room };
  }

  leaveRoom(userId, roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.participants.delete(userId);
      
      if (room.participants.size === 0) {
        // Delete empty room
        this.rooms.delete(roomId);
        console.log(`🗑️  Room ${roomId} deleted (empty)`);
      } else if (room.hostId === userId) {
        // Transfer host to another participant
        room.hostId = Array.from(room.participants)[0];
        console.log(`👑 Host transferred in room ${roomId}`);
      }
    }
    
    const user = this.connections.get(userId);
    if (user) {
      user.roomId = null;
      user.isHost = false;
    }
  }

  broadcastToRoom(roomId, message, excludeUserId = null) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    room.participants.forEach(participantId => {
      if (participantId !== excludeUserId) {
        const participant = this.connections.get(participantId);
        if (participant && participant.ws.readyState === WebSocket.OPEN) {
          participant.ws.send(JSON.stringify(message));
          participant.stats.messagesSent++;
        }
      }
    });
  }

  getStats() {
    return {
      ...this.stats,
      activeRooms: this.rooms.size,
      connectionDetails: Array.from(this.connections.values()).map(conn => ({
        id: conn.id,
        isHost: conn.isHost,
        roomId: conn.roomId,
        joinedAt: conn.joinedAt,
        stats: conn.stats
      }))
    };
  }
}

const connectionManager = new ConnectionManager();

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  let connectionId = null;
  
  console.log('🔌 New WebSocket connection established');
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      await handleMessage(ws, data);
    } catch (error) {
      console.error('❌ Error processing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  ws.on('close', () => {
    if (connectionId) {
      connectionManager.removeConnection(connectionId);
      broadcastStats();
    }
    console.log(`🔌 WebSocket connection closed: ${connectionId}`);
  });

  ws.on('error', (error) => {
    console.error('🚨 WebSocket error:', error);
  });

  // Handle incoming messages
  async function handleMessage(ws, data) {
    const { type } = data;
    
    switch (type) {
      case 'register':
        connectionId = data.id || crypto.randomBytes(4).toString('hex');
        connectionManager.addConnection(connectionId, ws);
        
        ws.send(JSON.stringify({
          type: 'registered',
          id: connectionId,
          timestamp: new Date().toISOString()
        }));
        
        broadcastStats();
        break;

      case 'create-room':
        if (!connectionId) return sendError('Not registered');
        
        const room = connectionManager.createRoom(connectionId);
        ws.send(JSON.stringify({
          type: 'room-created',
          roomId: room.id,
          hostId: connectionId
        }));
        break;

      case 'join-room':
        if (!connectionId) return sendError('Not registered');
        
        const joinResult = connectionManager.joinRoom(connectionId, data.roomId);
        if (joinResult.success) {
          ws.send(JSON.stringify({
            type: 'room-joined',
            roomId: data.roomId,
            participants: Array.from(joinResult.room.participants)
          }));
          
          // Notify other participants
          connectionManager.broadcastToRoom(data.roomId, {
            type: 'participant-joined',
            userId: connectionId,
            participants: Array.from(joinResult.room.participants)
          }, connectionId);
        } else {
          sendError(joinResult.error);
        }
        break;

      case 'offer':
      case 'answer':
      case 'ice-candidate':
        // Forward WebRTC signaling messages
        const connection = connectionManager.getConnection(connectionId);
        if (connection && connection.roomId) {
          connectionManager.broadcastToRoom(connection.roomId, {
            ...data,
            from: connectionId
          }, connectionId);
          
          connection.stats.messagesReceived++;
        }
        break;

      case 'remote-control':
        // Handle remote control commands
        handleRemoteControl(connectionId, data);
        break;

      case 'file-transfer':
        // Handle file transfer commands
        handleFileTransfer(connectionId, data);
        break;

      case 'chat-message':
        // Handle chat messages
        handleChatMessage(connectionId, data);
        break;

      case 'screen-share':
        // Handle screen sharing commands
        handleScreenShare(connectionId, data);
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;

      case 'get-stats':
        ws.send(JSON.stringify({
          type: 'stats',
          data: connectionManager.getStats()
        }));
        break;

      default:
        sendError(`Unknown message type: ${type}`);
    }

    function sendError(message) {
      ws.send(JSON.stringify({
        type: 'error',
        message,
        timestamp: new Date().toISOString()
      }));
    }
  }
});

// Remote control handling
function handleRemoteControl(userId, data) {
  const connection = connectionManager.getConnection(userId);
  if (!connection || !connection.roomId) return;

  const controlData = {
    type: 'remote-control',
    action: data.action,
    data: data.data,
    from: userId,
    timestamp: Date.now()
  };

  switch (data.action) {
    case 'mouse-move':
    case 'mouse-click':
    case 'mouse-scroll':
      controlData.coordinates = data.coordinates;
      controlData.button = data.button;
      break;
      
    case 'key-press':
    case 'key-release':
      controlData.key = data.key;
      controlData.modifiers = data.modifiers;
      break;
      
    case 'clipboard':
      controlData.content = data.content;
      break;
  }

  connectionManager.broadcastToRoom(connection.roomId, controlData, userId);
  connection.stats.messagesReceived++;
}

// File transfer handling
function handleFileTransfer(userId, data) {
  const connection = connectionManager.getConnection(userId);
  if (!connection || !connection.roomId) return;

  const transferData = {
    type: 'file-transfer',
    action: data.action,
    from: userId,
    timestamp: Date.now(),
    ...data
  };

  switch (data.action) {
    case 'offer':
      transferData.fileName = data.fileName;
      transferData.fileSize = data.fileSize;
      transferData.fileType = data.fileType;
      break;
      
    case 'accept':
    case 'reject':
      transferData.transferId = data.transferId;
      break;
      
    case 'chunk':
      transferData.transferId = data.transferId;
      transferData.chunkIndex = data.chunkIndex;
      transferData.chunkData = data.chunkData;
      transferData.isLast = data.isLast;
      
      // Update transfer stats
      connection.stats.bytesTransferred += (data.chunkData?.length || 0);
      connectionManager.stats.dataTransferred += (data.chunkData?.length || 0);
      break;
      
    case 'complete':
    case 'error':
      transferData.transferId = data.transferId;
      transferData.message = data.message;
      break;
  }

  connectionManager.broadcastToRoom(connection.roomId, transferData, userId);
}

// Chat message handling
function handleChatMessage(userId, data) {
  const connection = connectionManager.getConnection(userId);
  if (!connection || !connection.roomId) return;

  const chatData = {
    type: 'chat-message',
    from: userId,
    message: data.message,
    timestamp: Date.now()
  };

  connectionManager.broadcastToRoom(connection.roomId, chatData, userId);
}

// Screen sharing handling
function handleScreenShare(userId, data) {
  const connection = connectionManager.getConnection(userId);
  if (!connection || !connection.roomId) return;

  const shareData = {
    type: 'screen-share',
    action: data.action,
    from: userId,
    timestamp: Date.now(),
    ...data
  };

  connectionManager.broadcastToRoom(connection.roomId, shareData, userId);
}

// Broadcast statistics to all connections
function broadcastStats() {
  const stats = connectionManager.getStats();
  const message = JSON.stringify({
    type: 'server-stats',
    data: stats
  });

  connectionManager.connections.forEach(connection => {
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(message);
    }
  });
}

// REST API endpoints
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    connections: connectionManager.stats.activeConnections,
    rooms: connectionManager.rooms.size
  });
});

app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    data: connectionManager.getStats()
  });
});

app.get('/api/rooms', (req, res) => {
  const rooms = Array.from(connectionManager.rooms.values()).map(room => ({
    id: room.id,
    participantCount: room.participants.size,
    createdAt: room.createdAt,
    settings: room.settings
  }));
  
  res.json({
    success: true,
    data: rooms
  });
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/build/index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('🚨 Server error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`
  🚀 Remote Desktop Pro Server Started!
  
  📡 WebSocket Server: ws://localhost:${PORT}
  🌐 HTTP Server: http://localhost:${PORT}
  📊 Health Check: http://localhost:${PORT}/api/health
  📈 Statistics: http://localhost:${PORT}/api/stats
  
  🔥 Ready for connections!
  `);
});

// Periodic cleanup and stats broadcast
setInterval(() => {
  // Clean up stale connections
  connectionManager.connections.forEach((connection, id) => {
    if (connection.ws.readyState === WebSocket.CLOSED) {
      connectionManager.removeConnection(id);
    }
  });
  
  // Broadcast updated stats
  broadcastStats();
}, 30000); // Every 30 seconds

module.exports = { app, server, connectionManager };