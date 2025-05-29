const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const robot = require('robotjs');

// Configure robotjs for optimal performance
robot.setXDisplayName(process.env.DISPLAY);
robot.setKeyboardDelay(1);
robot.setMouseDelay(1);

class DesktopAgent {
  constructor() {
    this.mainWindow = null;
    this.isHost = false;
    this.connectionId = null;
    this.ws = null;
    this.screenStream = null;
    this.isStreaming = false;
    this.allowRemoteControl = false;
    this.frameRate = 30;
    this.quality = 'high';
    this.connectedClients = new Set();
    
    // Performance tracking
    this.stats = {
      framesStreamed: 0,
      commandsReceived: 0,
      bytesTransferred: 0,
      averageFPS: 0,
      lastFrameTime: 0
    };
  }

  async initialize() {
    await this.createMainWindow();
    this.setupIPC();
    this.registerGlobalShortcuts();
    console.log('🖥️  Desktop Agent initialized successfully');
  }

  async createMainWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false
      },
      icon: path.join(__dirname, '../assets/icon.png'),
      title: 'Remote Desktop Pro - Desktop Agent',
      show: false
    });

    // Load the agent interface
    await this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    
    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show();
      if (process.env.NODE_ENV === 'development') {
        this.mainWindow.webContents.openDevTools();
      }
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
      this.cleanup();
    });

    // Handle window events
    this.mainWindow.on('minimize', () => {
      this.mainWindow.hide(); // Hide to system tray
    });

    this.mainWindow.on('close', (event) => {
      if (this.isStreaming) {
        event.preventDefault();
        this.showConfirmationDialog();
      }
    });
  }

  setupIPC() {
    // Get available screens
    ipcMain.handle('get-screens', async () => {
      const displays = screen.getAllDisplays();
      return displays.map(display => ({
        id: display.id,
        label: `Screen ${display.id}`,
        bounds: display.bounds,
        primary: display.primary
      }));
    });

    // Start screen sharing
    ipcMain.handle('start-screen-share', async (event, screenId, options = {}) => {
      try {
        this.frameRate = options.frameRate || 30;
        this.quality = options.quality || 'high';
        
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 150, height: 150 }
        });

        const selectedScreen = sources.find(source => 
          source.display_id === screenId.toString()
        ) || sources[0];

        await this.startScreenCapture(selectedScreen.id);
        return { success: true, screenId: selectedScreen.id };
      } catch (error) {
        console.error('❌ Failed to start screen share:', error);
        return { success: false, error: error.message };
      }
    });

    // Stop screen sharing
    ipcMain.handle('stop-screen-share', async () => {
      this.stopScreenCapture();
      return { success: true };
    });

    // Connect to signaling server
    ipcMain.handle('connect-to-server', async (event, serverUrl) => {
      return await this.connectToServer(serverUrl);
    });

    // Toggle remote control
    ipcMain.handle('toggle-remote-control', async (event, enabled) => {
      this.allowRemoteControl = enabled;
      return { success: true, enabled };
    });

    // Get system stats
    ipcMain.handle('get-system-stats', async () => {
      return {
        ...this.stats,
        cpuUsage: process.cpuUsage(),
        memoryUsage: process.memoryUsage(),
        isStreaming: this.isStreaming,
        connectedClients: this.connectedClients.size,
        allowRemoteControl: this.allowRemoteControl
      };
    });

    // Handle file operations
    ipcMain.handle('save-received-file', async (event, fileName, fileData) => {
      try {
        const downloadsPath = path.join(require('os').homedir(), 'Downloads');
        const filePath = path.join(downloadsPath, fileName);
        
        await fs.promises.writeFile(filePath, Buffer.from(fileData));
        return { success: true, filePath };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
  }

  registerGlobalShortcuts() {
    // Toggle screen share with Ctrl+Shift+S
    globalShortcut.register('CommandOrControl+Shift+S', () => {
      if (this.isStreaming) {
        this.stopScreenCapture();
      } else {
        this.mainWindow.webContents.send('request-screen-share');
      }
    });

    // Toggle remote control with Ctrl+Shift+R
    globalShortcut.register('CommandOrControl+Shift+R', () => {
      this.allowRemoteControl = !this.allowRemoteControl;
      this.mainWindow.webContents.send('remote-control-toggled', this.allowRemoteControl);
    });

    // Emergency disconnect with Ctrl+Shift+D
    globalShortcut.register('CommandOrControl+Shift+D', () => {
      this.emergencyDisconnect();
    });
  }

  async connectToServer(serverUrl) {
    try {
      if (this.ws) {
        this.ws.close();
      }

      this.ws = new WebSocket(serverUrl);
      
      return new Promise((resolve, reject) => {
        this.ws.on('open', () => {
          this.connectionId = this.generateConnectionId();
          this.ws.send(JSON.stringify({
            type: 'register',
            id: this.connectionId,
            deviceType: 'desktop',
            capabilities: {
              screenShare: true,
              remoteControl: true,
              fileTransfer: true
            }
          }));
          
          console.log('🔌 Connected to signaling server');
          resolve({ success: true, connectionId: this.connectionId });
        });

        this.ws.on('message', (data) => {
          this.handleSignalingMessage(JSON.parse(data.toString()));
        });

        this.ws.on('error', (error) => {
          console.error('🚨 WebSocket error:', error);
          reject({ success: false, error: error.message });
        });

        this.ws.on('close', () => {
          console.log('🔌 Disconnected from signaling server');
          this.mainWindow.webContents.send('server-disconnected');
        });

        setTimeout(() => {
          reject({ success: false, error: 'Connection timeout' });
        }, 10000);
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  handleSignalingMessage(message) {
    switch (message.type) {
      case 'registered':
        this.connectionId = message.id;
        this.mainWindow.webContents.send('registered', { id: message.id });
        break;

      case 'remote-control':
        if (this.allowRemoteControl) {
          this.executeRemoteCommand(message);
        }
        break;

      case 'file-transfer':
        this.handleFileTransfer(message);
        break;

      case 'client-connected':
        this.connectedClients.add(message.clientId);
        this.mainWindow.webContents.send('client-connected', message.clientId);
        break;

      case 'client-disconnected':
        this.connectedClients.delete(message.clientId);
        this.mainWindow.webContents.send('client-disconnected', message.clientId);
        break;

      default:
        // Forward to renderer process
        this.mainWindow.webContents.send('signaling-message', message);
    }
  }

  async startScreenCapture(sourceId) {
    try {
      this.isStreaming = true;
      this.stats.lastFrameTime = Date.now();
      
      // Start capture loop
      this.captureLoop();
      
      console.log('📺 Screen capture started');
      this.mainWindow.webContents.send('screen-share-started', { sourceId });
      
      return true;
    } catch (error) {
      console.error('❌ Failed to start screen capture:', error);
      this.isStreaming = false;
      throw error;
    }
  }

  async captureLoop() {
    if (!this.isStreaming) return;

    try {
      const startTime = Date.now();
      
      // Capture screen
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      });

      if (sources.length > 0) {
        const screenshot = sources[0].thumbnail.toPNG();
        
        // Send to connected clients
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'screen-frame',
            data: screenshot.toString('base64'),
            timestamp: Date.now(),
            quality: this.quality
          }));
          
          this.stats.framesStreamed++;
          this.stats.bytesTransferred += screenshot.length;
        }

        // Calculate FPS
        const frameTime = Date.now() - startTime;
        this.stats.averageFPS = Math.round(1000 / (frameTime || 1));
        this.stats.lastFrameTime = Date.now();
        
        // Send stats to renderer
        this.mainWindow.webContents.send('stats-update', this.stats);
      }

      // Schedule next frame
      setTimeout(() => this.captureLoop(), 1000 / this.frameRate);
      
    } catch (error) {
      console.error('❌ Screen capture error:', error);
      setTimeout(() => this.captureLoop(), 1000); // Retry after 1 second
    }
  }

  stopScreenCapture() {
    this.isStreaming = false;
    console.log('📺 Screen capture stopped');
    this.mainWindow.webContents.send('screen-share-stopped');
  }

  executeRemoteCommand(command) {
    if (!this.allowRemoteControl) return;

    try {
      switch (command.action) {
        case 'mouse-move':
          robot.moveMouse(command.data.x, command.data.y);
          break;

        case 'mouse-click':
          robot.mouseClick(command.data.button || 'left', command.data.double || false);
          break;

        case 'mouse-scroll':
          robot.scrollMouse(command.data.x || 0, command.data.y || 0);
          break;

        case 'key-press':
          if (command.data.modifiers && command.data.modifiers.length > 0) {
            robot.keyTap(command.data.key, command.data.modifiers);
          } else {
            robot.keyTap(command.data.key);
          }
          break;

        case 'key-combination':
          robot.keyTap(command.data.key, command.data.modifiers);
          break;

        case 'type-text':
          robot.typeString(command.data.text);
          break;

        case 'clipboard':
          // Handle clipboard operations
          this.handleClipboard(command.data);
          break;

        default:
          console.warn('⚠️  Unknown remote command:', command.action);
      }

      this.stats.commandsReceived++;
      
    } catch (error) {
      console.error('❌ Failed to execute remote command:', error);
    }
  }

  handleFileTransfer(message) {
    switch (message.action) {
      case 'offer':
        // Show file transfer request to user
        this.mainWindow.webContents.send('file-transfer-request', {
          from: message.from,
          fileName: message.fileName,
          fileSize: message.fileSize,
          transferId: message.transferId
        });
        break;

      case 'chunk':
        // Handle incoming file chunk
        this.mainWindow.webContents.send('file-chunk-received', message);
        break;

      case 'complete':
        // File transfer completed
        this.mainWindow.webContents.send('file-transfer-complete', message);
        break;

      case 'error':
        console.error('❌ File transfer error:', message.message);
        this.mainWindow.webContents.send('file-transfer-error', message);
        break;
    }
  }

  handleClipboard(data) {
    const { clipboard } = require('electron');
    
    if (data.action === 'set') {
      clipboard.writeText(data.content);
    } else if (data.action === 'get') {
      const content = clipboard.readText();
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'clipboard-content',
          content: content
        }));
      }
    }
  }

  generateConnectionId() {
    return Math.random().toString(36).substr(2, 9).toUpperCase();
  }

  emergencyDisconnect() {
    this.stopScreenCapture();
    this.allowRemoteControl = false;
    if (this.ws) {
      this.ws.close();
    }
    this.mainWindow.webContents.send('emergency-disconnect');
    console.log('🚨 Emergency disconnect activated');
  }

  cleanup() {
    this.stopScreenCapture();
    if (this.ws) {
      this.ws.close();
    }
    globalShortcut.unregisterAll();
  }
}

// Application lifecycle
const desktopAgent = new DesktopAgent();

app.whenReady().then(async () => {
  await desktopAgent.initialize();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await desktopAgent.initialize();
  }
});

app.on('before-quit', () => {
  desktopAgent.cleanup();
});

// Handle certificate errors for self-signed certificates
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
});

module.exports = { desktopAgent };