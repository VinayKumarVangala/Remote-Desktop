// webrtc/ConnectionManager.ts
import { EventEmitter } from 'events';

export interface ConnectionConfig {
  iceServers: RTCIceServer[];
  socketUrl: string;
  roomId: string;
  isHost: boolean;
}

export interface RemoteDesktopStream {
  video: MediaStream;
  audio?: MediaStream;
  dataChannel: RTCDataChannel;
}

export class WebRTCConnectionManager extends EventEmitter {
  private peerConnection: RTCPeerConnection | null = null;
  private socket: WebSocket | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private config: ConnectionConfig;
  private connectionState: RTCPeerConnectionState = 'new';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor(config: ConnectionConfig) {
    super();
    this.config = config;
    this.initializeConnection();
  }

  private async initializeConnection(): Promise<void> {
    try {
      await this.setupWebSocket();
      await this.setupPeerConnection();
      
      if (this.config.isHost) {
        await this.setupDataChannel();
      }
    } catch (error) {
      console.error('Failed to initialize connection:', error);
      this.emit('error', error);
    }
  }

  private setupWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.config.socketUrl);
      
      this.socket.onopen = () => {
        console.log('WebSocket connected');
        this.socket?.send(JSON.stringify({
          type: 'join-room',
          roomId: this.config.roomId,
          isHost: this.config.isHost
        }));
        resolve();
      };

      this.socket.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          await this.handleSignalingMessage(message);
        } catch (error) {
          console.error('Error handling signaling message:', error);
        }
      };

      this.socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      };

      this.socket.onclose = () => {
        console.log('WebSocket disconnected');
        this.handleDisconnection();
      };
    });
  }

  private async setupPeerConnection(): Promise<void> {
    this.peerConnection = new RTCPeerConnection({
      iceServers: this.config.iceServers
    });

    // Handle ICE candidates
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({
          type: 'ice-candidate',
          candidate: event.candidate,
          roomId: this.config.roomId
        }));
      }
    };

    // Handle connection state changes
    this.peerConnection.onconnectionstatechange = () => {
      this.connectionState = this.peerConnection!.connectionState;
      console.log('Connection state:', this.connectionState);
      
      this.emit('connectionStateChange', this.connectionState);
      
      if (this.connectionState === 'connected') {
        this.reconnectAttempts = 0;
        this.emit('connected');
      } else if (this.connectionState === 'disconnected' || this.connectionState === 'failed') {
        this.handleConnectionFailure();
      }
    };

    // Handle incoming streams (for viewer)
    this.peerConnection.ontrack = (event) => {
      console.log('Received remote stream');
      this.remoteStream = event.streams[0];
      this.emit('remoteStream', this.remoteStream);
    };

    // Handle incoming data channels (for viewer)
    this.peerConnection.ondatachannel = (event) => {
      const channel = event.channel;
      this.setupDataChannelHandlers(channel);
    };
  }

  private setupDataChannel(): void {
    if (!this.peerConnection) return;

    this.dataChannel = this.peerConnection.createDataChannel('control', {
      ordered: true
    });

    this.setupDataChannelHandlers(this.dataChannel);
  }

  private setupDataChannelHandlers(channel: RTCDataChannel): void {
    channel.onopen = () => {
      console.log('Data channel opened');
      this.emit('dataChannelOpen');
    };

    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.emit('controlMessage', data);
      } catch (error) {
        console.error('Error parsing control message:', error);
      }
    };

    channel.onclose = () => {
      console.log('Data channel closed');
      this.emit('dataChannelClose');
    };

    channel.onerror = (error) => {
      console.error('Data channel error:', error);
      this.emit('dataChannelError', error);
    };

    this.dataChannel = channel;
  }

  private async handleSignalingMessage(message: any): Promise<void> {
    if (!this.peerConnection) return;

    switch (message.type) {
      case 'offer':
        await this.handleOffer(message.offer);
        break;
      case 'answer':
        await this.handleAnswer(message.answer);
        break;
      case 'ice-candidate':
        await this.handleIceCandidate(message.candidate);
        break;
      case 'peer-joined':
        if (this.config.isHost) {
          await this.createOffer();
        }
        break;
      case 'peer-left':
        this.emit('peerDisconnected');
        break;
      default:
        console.log('Unknown signaling message:', message);
    }
  }

  private async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.peerConnection) return;

    await this.peerConnection.setRemoteDescription(offer);
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        type: 'answer',
        answer: answer,
        roomId: this.config.roomId
      }));
    }
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.peerConnection) return;
    await this.peerConnection.setRemoteDescription(answer);
  }

  private async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.peerConnection) return;
    await this.peerConnection.addIceCandidate(candidate);
  }

  private async createOffer(): Promise<void> {
    if (!this.peerConnection) return;

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        type: 'offer',
        offer: offer,
        roomId: this.config.roomId
      }));
    }
  }

  // Public methods for adding local stream (host)
  public async addLocalStream(stream: MediaStream): Promise<void> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    this.localStream = stream;
    
    // Add all tracks to peer connection
    stream.getTracks().forEach(track => {
      this.peerConnection!.addTrack(track, stream);
    });

    console.log('Local stream added to peer connection');
    this.emit('localStreamAdded', stream);
  }

  // Send control messages through data channel
  public sendControlMessage(message: any): void {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(message));
    } else {
      console.warn('Data channel not open, cannot send control message');
    }
  }

  // Handle connection failures and reconnection
  private async handleConnectionFailure(): Promise<void> {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      
      setTimeout(() => {
        this.reconnect();
      }, 2000 * this.reconnectAttempts); // Exponential backoff
    } else {
      console.error('Max reconnection attempts reached');
      this.emit('connectionFailed');
    }
  }

  private async reconnect(): Promise<void> {
    try {
      await this.cleanup();
      await this.initializeConnection();
    } catch (error) {
      console.error('Reconnection failed:', error);
      this.emit('reconnectionFailed', error);
    }
  }

  private handleDisconnection(): void {
    this.emit('disconnected');
    this.handleConnectionFailure();
  }

  // Get connection statistics
  public async getConnectionStats(): Promise<RTCStatsReport | null> {
    if (!this.peerConnection) return null;
    return await this.peerConnection.getStats();
  }

  // Get current connection state
  public getConnectionState(): RTCPeerConnectionState {
    return this.connectionState;
  }

  // Check if data channel is ready
  public isDataChannelReady(): boolean {
    return this.dataChannel?.readyState === 'open';
  }

  // Get remote stream
  public getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  // Clean up resources
  private async cleanup(): Promise<void> {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  // Public cleanup method
  public async disconnect(): Promise<void> {
    console.log('Disconnecting WebRTC connection');
    await this.cleanup();
    this.emit('disconnected');
  }
}

// Usage example and utility functions
export class ConnectionFactory {
  static createHostConnection(roomId: string, socketUrl: string): WebRTCConnectionManager {
    return new WebRTCConnectionManager({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      socketUrl,
      roomId,
      isHost: true
    });
  }

  static createViewerConnection(roomId: string, socketUrl: string): WebRTCConnectionManager {
    return new WebRTCConnectionManager({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      socketUrl,
      roomId,
      isHost: false
    });
  }
}

// Control message types for desktop interaction
export interface MouseClickMessage {
  type: 'mouse-click';
  x: number;
  y: number;
  button: 'left' | 'right' | 'middle';
}

export interface MouseMoveMessage {
  type: 'mouse-move';
  x: number;
  y: number;
}

export interface KeyboardMessage {
  type: 'keyboard';
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export interface ScrollMessage {
  type: 'scroll';
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
}

export type ControlMessage = MouseClickMessage | MouseMoveMessage | KeyboardMessage | ScrollMessage;