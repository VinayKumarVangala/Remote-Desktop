import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Monitor, 
  Smartphone, 
  Upload, 
  Download, 
  Settings, 
  Lock, 
  Unlock,
  Mouse,
  Keyboard,
  HardDrive,
  Play,
  Pause,
  Square,
  Maximize,
  Minimize,
  RotateCcw,
  Wifi,
  WifiOff,
  Users,
  MessageSquare,
  Palette
} from 'lucide-react';

const RemoteDesktopPro = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [remoteConnectionId, setRemoteConnectionId] = useState('');
  const [isHost, setIsHost] = useState(true);
  const [stream, setStream] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [fileTransferProgress, setFileTransferProgress] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [transferredFiles, setTransferredFiles] = useState([]);
  const [connectionQuality, setConnectionQuality] = useState('excellent');
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const socketRef = useRef(null);
  const fileInputRef = useRef(null);

  // WebRTC Configuration
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // Initialize WebSocket connection
  useEffect(() => {
    const socket = new WebSocket('ws://localhost:8080');
    socketRef.current = socket;

    socket.onopen = () => {
      const id = Math.random().toString(36).substr(2, 9);
      setConnectionId(id);
      socket.send(JSON.stringify({ type: 'register', id }));
    };

    socket.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      await handleSignalingMessage(data);
    };

    return () => socket.close();
  }, []);

  // Handle WebRTC signaling
  const handleSignalingMessage = async (data) => {
    const pc = peerConnectionRef.current;
    
    switch (data.type) {
      case 'offer':
        if (!pc) initializePeerConnection();
        await peerConnectionRef.current.setRemoteDescription(data.offer);
        const answer = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
        socketRef.current.send(JSON.stringify({
          type: 'answer',
          answer,
          to: data.from
        }));
        break;
        
      case 'answer':
        await pc.setRemoteDescription(data.answer);
        break;
        
      case 'ice-candidate':
        await pc.addIceCandidate(data.candidate);
        break;
        
      case 'connection-established':
        setIsConnected(true);
        setConnectionStatus('connected');
        break;
    }
  };

  // Initialize WebRTC peer connection
  const initializePeerConnection = () => {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnectionRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.send(JSON.stringify({
          type: 'ice-candidate',
          candidate: event.candidate,
          to: remoteConnectionId
        }));
      }
    };

    pc.ontrack = (event) => {
      setStream(event.streams[0]);
      if (videoRef.current) {
        videoRef.current.srcObject = event.streams[0];
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.onmessage = handleDataChannelMessage;
    };

    // Create data channel for file transfer and remote control
    const dataChannel = pc.createDataChannel('control', { ordered: true });
    dataChannel.onopen = () => console.log('Data channel opened');
    dataChannel.onmessage = handleDataChannelMessage;

    return pc;
  };

  // Handle data channel messages
  const handleDataChannelMessage = (event) => {
    const data = JSON.parse(event.data);
    
    switch (data.type) {
      case 'mouse-move':
        setMousePosition({ x: data.x, y: data.y });
        break;
      case 'file-chunk':
        handleFileChunk(data);
        break;
      case 'file-complete':
        handleFileComplete(data);
        break;
    }
  };

  // Start connection
  const startConnection = async () => {
    if (!remoteConnectionId) return;
    
    setConnectionStatus('connecting');
    const pc = initializePeerConnection();
    
    if (isHost) {
      // Host: Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      socketRef.current.send(JSON.stringify({
        type: 'offer',
        offer,
        to: remoteConnectionId
      }));
    }
  };

  // Handle mouse events on remote screen
  const handleMouseEvent = useCallback((event) => {
    if (!isConnected || !peerConnectionRef.current) return;
    
    const rect = videoRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    
    const dataChannel = peerConnectionRef.current.createDataChannel('mouse');
    dataChannel.send(JSON.stringify({
      type: 'mouse-event',
      x,
      y,
      button: event.button,
      action: event.type
    }));
  }, [isConnected]);

  // Handle keyboard events
  const handleKeyboardEvent = useCallback((event) => {
    if (!isConnected) return;
    
    const dataChannel = peerConnectionRef.current.createDataChannel('keyboard');
    dataChannel.send(JSON.stringify({
      type: 'keyboard-event',
      key: event.key,
      code: event.code,
      action: event.type
    }));
  }, [isConnected]);

  // File transfer functionality
  const handleFileTransfer = async (file) => {
    if (!isConnected) return;
    
    const chunkSize = 16384; // 16KB chunks
    const totalChunks = Math.ceil(file.size / chunkSize);
    const dataChannel = peerConnectionRef.current.createDataChannel('file');
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunk = file.slice(start, end);
      
      const arrayBuffer = await chunk.arrayBuffer();
      dataChannel.send(JSON.stringify({
        type: 'file-chunk',
        fileName: file.name,
        fileSize: file.size,
        chunkIndex: i,
        totalChunks,
        data: Array.from(new Uint8Array(arrayBuffer))
      }));
      
      setFileTransferProgress((i + 1) / totalChunks * 100);
    }
  };

  const handleFileChunk = (data) => {
    // Handle incoming file chunks
    // Implementation for receiving files
  };

  const handleFileComplete = (data) => {
    setTransferredFiles(prev => [...prev, {
      name: data.fileName,
      size: data.fileSize,
      timestamp: new Date()
    }]);
    setFileTransferProgress(100);
  };

  // UI Event handlers
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      videoRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const getConnectionStatusColor = () => {
    switch (connectionStatus) {
      case 'connected': return 'text-green-500';
      case 'connecting': return 'text-yellow-500';
      default: return 'text-red-500';
    }
  };

  const getQualityIcon = () => {
    switch (connectionQuality) {
      case 'excellent': return <Wifi className="w-4 h-4 text-green-500" />;
      case 'good': return <Wifi className="w-4 h-4 text-yellow-500" />;
      default: return <WifiOff className="w-4 h-4 text-red-500" />;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white">
      {/* Header */}
      <div className="bg-black/30 backdrop-blur-md border-b border-white/10 p-4">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div className="flex items-center space-x-3">
            <div className="bg-gradient-to-r from-blue-500 to-purple-600 p-2 rounded-lg">
              <Monitor className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                Remote Desktop Pro
              </h1>
              <p className="text-sm text-gray-400">Professional Remote Access Solution</p>
            </div>
          </div>
          
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              {getQualityIcon()}
              <span className={`text-sm ${getConnectionStatusColor()}`}>
                {connectionStatus}
              </span>
            </div>
            
            <div className="bg-black/20 px-3 py-1 rounded-full text-sm">
              ID: {connectionId}
            </div>
          </div>
        </div>
      </div>

      <div className="flex h-[calc(100vh-80px)]">
        {/* Sidebar */}
        <div className="w-80 bg-black/20 backdrop-blur-md border-r border-white/10 p-4 space-y-6">
          {/* Connection Panel */}
          <div className="bg-white/5 rounded-xl p-4 border border-white/10">
            <h3 className="text-lg font-semibold mb-4 flex items-center">
              <Users className="w-5 h-5 mr-2" />
              Connection
            </h3>
            
            <div className="space-y-3">
              <div className="flex space-x-2">
                <button
                  onClick={() => setIsHost(true)}
                  className={`flex-1 py-2 px-3 rounded-lg text-sm transition-all ${
                    isHost 
                      ? 'bg-blue-600 text-white' 
                      : 'bg-white/10 text-gray-300 hover:bg-white/20'
                  }`}
                >
                  <Monitor className="w-4 h-4 inline mr-1" />
                  Host
                </button>
                <button
                  onClick={() => setIsHost(false)}
                  className={`flex-1 py-2 px-3 rounded-lg text-sm transition-all ${
                    !isHost 
                      ? 'bg-blue-600 text-white' 
                      : 'bg-white/10 text-gray-300 hover:bg-white/20'
                  }`}
                >
                  <Smartphone className="w-4 h-4 inline mr-1" />
                  Client
                </button>
              </div>
              
              <input
                type="text"
                placeholder="Enter Remote ID"
                value={remoteConnectionId}
                onChange={(e) => setRemoteConnectionId(e.target.value)}
                className="w-full bg-black/30 border border-white/20 rounded-lg px-3 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
              />
              
              <button
                onClick={startConnection}
                disabled={!remoteConnectionId || isConnected}
                className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 disabled:from-gray-600 disabled:to-gray-600 text-white py-2 rounded-lg transition-all font-medium"
              >
                {isConnected ? 'Connected' : 'Connect'}
              </button>
            </div>
          </div>

          {/* Control Panel */}
          <div className="bg-white/5 rounded-xl p-4 border border-white/10">
            <h3 className="text-lg font-semibold mb-4 flex items-center">
              <Settings className="w-5 h-5 mr-2" />
              Controls
            </h3>
            
            <div className="grid grid-cols-2 gap-2">
              <button className="flex items-center justify-center bg-white/10 hover:bg-white/20 p-3 rounded-lg transition-all">
                <Mouse className="w-4 h-4 mr-1" />
                <span className="text-sm">Mouse</span>
              </button>
              <button className="flex items-center justify-center bg-white/10 hover:bg-white/20 p-3 rounded-lg transition-all">
                <Keyboard className="w-4 h-4 mr-1" />
                <span className="text-sm">Keyboard</span>
              </button>
              <button 
                onClick={toggleFullscreen}
                className="flex items-center justify-center bg-white/10 hover:bg-white/20 p-3 rounded-lg transition-all"
              >
                <Maximize className="w-4 h-4 mr-1" />
                <span className="text-sm">Fullscreen</span>
              </button>
              <button 
                onClick={() => setShowAnnotations(!showAnnotations)}
                className="flex items-center justify-center bg-white/10 hover:bg-white/20 p-3 rounded-lg transition-all"
              >
                <Palette className="w-4 h-4 mr-1" />
                <span className="text-sm">Annotate</span>
              </button>
            </div>
          </div>

          {/* File Transfer */}
          <div className="bg-white/5 rounded-xl p-4 border border-white/10">
            <h3 className="text-lg font-semibold mb-4 flex items-center">
              <HardDrive className="w-5 h-5 mr-2" />
              File Transfer
            </h3>
            
            <div className="space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={(e) => Array.from(e.target.files).forEach(handleFileTransfer)}
                className="hidden"
              />
              
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full bg-green-600 hover:bg-green-700 text-white py-2 rounded-lg transition-all flex items-center justify-center"
              >
                <Upload className="w-4 h-4 mr-1" />
                Send Files
              </button>
              
              {fileTransferProgress > 0 && fileTransferProgress < 100 && (
                <div className="w-full bg-gray-700 rounded-full h-2">
                  <div 
                    className="bg-blue-600 h-2 rounded-full transition-all"
                    style={{ width: `${fileTransferProgress}%` }}
                  ></div>
                </div>
              )}
              
              {transferredFiles.length > 0 && (
                <div className="max-h-32 overflow-y-auto space-y-2">
                  {transferredFiles.map((file, index) => (
                    <div key={index} className="bg-black/30 p-2 rounded text-sm">
                      <div className="flex items-center justify-between">
                        <span className="truncate">{file.name}</span>
                        <Download className="w-4 h-4 text-green-500" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Main Display Area */}
        <div className="flex-1 relative">
          <div className="h-full bg-black/10 flex items-center justify-center">
            {isConnected && stream ? (
              <div className="relative w-full h-full">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-contain cursor-crosshair"
                  onClick={handleMouseEvent}
                  onMouseMove={handleMouseEvent}
                  onKeyDown={handleKeyboardEvent}
                  tabIndex={0}
                />
                
                {/* Remote cursor */}
                <div
                  className="absolute w-4 h-4 bg-red-500 rounded-full pointer-events-none transition-all duration-75"
                  style={{
                    left: `${mousePosition.x}%`,
                    top: `${mousePosition.y}%`,
                    transform: 'translate(-50%, -50%)'
                  }}
                />
                
                {/* Annotation canvas */}
                {showAnnotations && (
                  <canvas
                    ref={canvasRef}
                    className="absolute inset-0 pointer-events-auto"
                    style={{ cursor: 'crosshair' }}
                  />
                )}
              </div>
            ) : (
              <div className="text-center">
                <div className="bg-white/5 rounded-full p-8 mb-4 inline-block">
                  <Monitor className="w-16 h-16 text-gray-400" />
                </div>
                <h2 className="text-2xl font-semibold mb-2">
                  {isConnected ? 'Waiting for stream...' : 'Ready to Connect'}
                </h2>
                <p className="text-gray-400">
                  {isHost 
                    ? 'Share your connection ID with the remote user'
                    : 'Enter the host\'s connection ID to start'
                  }
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default RemoteDesktopPro;