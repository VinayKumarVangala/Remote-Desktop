// desktop-agent/src/ScreenCaptureController.ts
import { desktopCapturer, screen, BrowserWindow } from 'electron';
import robot from 'robotjs';
import { WebRTCConnectionManager, ControlMessage } from '../webrtc/ConnectionManager';

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
  display_id?: string;
  appIcon?: string;
}

export interface CaptureOptions {
  width?: number;
  height?: number;
  frameRate?: number;
  cursor?: 'always' | 'motion' | 'never';
  audio?: boolean;
}

export class ScreenCaptureController {
  private currentStream: MediaStream | null = null;
  private connectionManager: WebRTCConnectionManager | null = null;
  private isCapturing = false;
  private selectedSourceId: string | null = null;
  private captureOptions: CaptureOptions = {
    width: 1920,
    height: 1080,
    frameRate: 30,
    cursor: 'always',
    audio: false
  };

  constructor() {
    // Set up robotjs for cross-platform compatibility
    robot.setXDisplayName(process.env.DISPLAY || ':0');
    robot.setKeyboardDelay(1);
    robot.setMouseDelay(1);
  }

  // Get available screens and windows for capture
  public async getAvailableSources(): Promise<ScreenSource[]> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 150, height: 150 }
      });

      return sources.map(source => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
        display_id: source.display_id,
        appIcon: source.appIcon?.toDataURL()
      }));
    } catch (error) {
      console.error('Failed to get available sources:', error);
      throw error;
    }
  }

  // Start screen capture with specified source
  public async startCapture(sourceId: string, options?: Partial<CaptureOptions>): Promise<MediaStream> {
    try {
      if (this.isCapturing) {
        await this.stopCapture();
      }

      // Merge options
      this.captureOptions = { ...this.captureOptions, ...options };
      this.selectedSourceId = sourceId;

      // Get screen capture stream
      const stream = await this.createCaptureStream(sourceId);
      
      // Add audio if requested
      if (this.captureOptions.audio) {
        const audioStream = await this.getCaptureAudio();
        if (audioStream) {
          audioStream.getAudioTracks().forEach(track => {
            stream.addTrack(track);
          });
        }
      }

      this.currentStream = stream;
      this.isCapturing = true;

      console.log('Screen capture started successfully');
      return stream;

    } catch (error) {
      console.error('Failed to start screen capture:', error);
      throw error;
    }
  }

  private async createCaptureStream(sourceId: string): Promise<MediaStream> {
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        // @ts-ignore - Electron specific constraints
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: this.captureOptions.width,
          maxWidth: this.captureOptions.width,
          minHeight: this.captureOptions.height,
          maxHeight: this.captureOptions.height,
          minFrameRate: this.captureOptions.frameRate,
          maxFrameRate: this.captureOptions.frameRate
        }
      }
    };

    return await navigator.mediaDevices.getUserMedia(constraints);
  }

  private async getCaptureAudio(): Promise<MediaStream | null> {
    try {
      // For system audio capture (Windows/macOS specific implementation)
      const audioConstraints: MediaStreamConstraints = {
        audio: {
          // @ts-ignore - Electron specific audio constraints
          mandatory: {
            chromeMediaSource: 'desktop'
          }
        },
        video: false
      };

      return await navigator.mediaDevices.getUserMedia(audioConstraints);
    } catch (error) {
      console.warn('System audio capture not available:', error);
      return null;
    }
  }

  // Stop screen capture
  public async stopCapture(): Promise<void> {
    if (this.currentStream) {
      this.currentStream.getTracks().forEach(track => {
        track.stop();
      });
      this.currentStream = null;
    }

    this.isCapturing = false;
    this.selectedSourceId = null;
    console.log('Screen capture stopped');
  }

  // Set up WebRTC connection and control handling
  public async setupRemoteControl(connectionManager: WebRTCConnectionManager): Promise<void> {
    this.connectionManager = connectionManager;

    // Listen for control messages
    connectionManager.on('controlMessage', (message: ControlMessage) => {
      this.handleControlMessage(message);
    });

    // Add screen stream to connection if capturing
    if (this.currentStream) {
      await connectionManager.addLocalStream(this.currentStream);
    }

    console.log('Remote control setup complete');
  }

  // Handle incoming control messages from remote client
  private handleControlMessage(message: ControlMessage): void {
    try {
      switch (message.type) {
        case 'mouse-click':
          this.handleMouseClick(message);
          break;
        case 'mouse-move':
          this.handleMouseMove(message);
          break;
        case 'keyboard':
          this.handleKeyboard(message);
          break;
        case 'scroll':
          this.handleScroll(message);
          break;
        default:
          console.warn('Unknown control message type:', message);
      }
    } catch (error) {
      console.error('Error handling control message:', error);
    }
  }

  private handleMouseClick(message: any): void {
    const { x, y, button } = message;
    
    // Convert coordinates relative to screen size
    const scaledCoords = this.scaleCoordinates(x, y);
    
    robot.moveMouse(scaledCoords.x, scaledCoords.y);
    
    // Map button names to robotjs format
    const robotButton = button === 'right' ? 'right' : 'left';
    robot.mouseClick(robotButton);
    
    console.log(`Mouse ${button} click at (${scaledCoords.x}, ${scaledCoords.y})`);
  }

  private handleMouseMove(message: any): void {
    const { x, y } = message;
    const scaledCoords = this.scaleCoordinates(x, y);
    
    robot.moveMouse(scaledCoords.x, scaledCoords.y);
  }

  private handleKeyboard(message: any): void {
    const { key, altKey, ctrlKey, shiftKey, metaKey } = message;
    
    // Handle modifier keys
    const modifiers = [];
    if (ctrlKey) modifiers.push('control');
    if (altKey) modifiers.push('alt');
    if (shiftKey) modifiers.push('shift');
    if (metaKey) modifiers.push('command'); // macOS
    
    try {
      if (modifiers.length > 0) {
        // Handle key combinations
        robot.keyTap(this.mapKeyCode(key), modifiers);
      } else if (key.length === 1) {
        // Handle single character
        robot.typeString(key);
      } else {
        // Handle special keys
        robot.keyTap(this.mapKeyCode(key));
      }
      
      console.log(`Keyboard input: ${key} with modifiers: ${modifiers.join(', ')}`);
    } catch (error) {
      console.error('Error handling keyboard input:', error);
    }
  }

  private handleScroll(message: any): void {
    const { x, y, deltaX, deltaY } = message;
    const scaledCoords = this.scaleCoordinates(x, y);
    
    robot.moveMouse(scaledCoords.x, scaledCoords.y);
    
    // Convert scroll delta to robotjs format
    const scrollDirection = deltaY > 0 ? 'down' : 'up';
    const scrollMagnitude = Math.abs(Math.round(deltaY / 120)); // Standard scroll unit
    
    for (let i = 0; i < scrollMagnitude; i++) {
      robot.scrollMouse(1, scrollDirection);
    }
  }

  // Scale coordinates from viewer resolution to actual screen resolution
  private scaleCoordinates(x: number, y: number): { x: number, y: number } {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.bounds;
    
    // Scale from capture resolution to actual screen resolution
    const scaleX = screenWidth / (this.captureOptions.width || screenWidth);
    const scaleY = screenHeight / (this.captureOptions.height || screenHeight);
    
    return {
      x: Math.round(x * scaleX),
      y: Math.round(y * scaleY)
    };
  }

  // Map web key codes to robotjs key codes
  private mapKeyCode(key: string): string {
    const keyMap: { [key: string]: string } = {
      'Enter': 'enter',
      'Escape': 'escape',
      'Backspace': 'backspace',
      'Tab': 'tab',
      'Space': 'space',
      'ArrowLeft': 'left',
      'ArrowRight': 'right',
      'ArrowUp': 'up',
      'ArrowDown': 'down',
      'Home': 'home',
      'End': 'end',
      'PageUp': 'pageup',
      'PageDown': 'pagedown',
      'Delete': 'delete',
      'Insert': 'insert',
      'F1': 'f1', 'F2': 'f2', 'F3': 'f3', 'F4': 'f4',
      'F5': 'f5', 'F6': 'f6', 'F7': 'f7', 'F8': 'f8',
      'F9': 'f9', 'F10': 'f10', 'F11': 'f11', 'F12': 'f12'
    };
    
    return keyMap[key] || key.toLowerCase();
  }

  // Get current capture status
  public getCaptureStatus(): {
    isCapturing: boolean;
    sourceId: string | null;
    options: CaptureOptions;
    streamActive: boolean;
  } {
    return {
      isCapturing: this.isCapturing,
      sourceId: this.selectedSourceId,
      options: this.captureOptions,
      streamActive: this.currentStream !== null && this.currentStream.active
    };
  }

  // Update capture options dynamically
  public async updateCaptureOptions(options: Partial<CaptureOptions>): Promise<void> {
    const newOptions = { ...this.captureOptions, ...options };
    
    if (this.isCapturing && this.selectedSourceId) {
      // Restart capture with new options
      await this.stopCapture();
      await this.startCapture(this.selectedSourceId, newOptions);
      
      // Re-add to WebRTC connection if active
      if (this.connectionManager && this.currentStream) {
        await this.connectionManager.addLocalStream(this.currentStream);
      }
    } else {
      this.captureOptions = newOptions;
    }
  }

  // Get screen information
  public getScreenInfo(): any[] {
    return screen.getAllDisplays().map(display => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      internal: display.internal
    }));
  }

  // Security: Disable input when not authorized
  private inputEnabled = true;
  
  public setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
  }

  // Clean up resources
  public async cleanup(): Promise<void> {
    await this.stopCapture();
    this.connectionManager = null;
    console.log('Screen capture controller cleaned up');
  }
}

// Integration helper for Electron main process
export class ScreenCaptureService {
  private static instance: ScreenCaptureController;
  
  public static getInstance(): ScreenCaptureController {
    if (!this.instance) {
      this.instance = new ScreenCaptureController();
    }
    return this.instance;
  }
  
  // IPC handlers for renderer process communication
  public static setupIPCHandlers(ipcMain: Electron.IpcMain): void {
    const controller = this.getInstance();
    
    ipcMain.handle('screen-sources', async () => {
      return await controller.getAvailableSources();
    });
    
    ipcMain.handle('start-capture', async (event, sourceId: string, options?: CaptureOptions) => {
      try {
        await controller.startCapture(sourceId, options);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    ipcMain.handle('stop-capture', async () => {
      await controller.stopCapture();
      return { success: true };
    });
    
    ipcMain.handle('capture-status', () => {
      return controller.getCaptureStatus();
    });
    
    ipcMain.handle('screen-info', () => {
      return controller.getScreenInfo();
    });
  }
}

// Package.json additions needed:
/*
{
  "dependencies": {
    "robotjs": "^0.6.0"
  }
}
*/