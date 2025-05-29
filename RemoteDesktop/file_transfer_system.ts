// file-transfer/FileTransferManager.ts
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface FileTransferOptions {
  chunkSize: number;
  maxConcurrentTransfers: number;
  allowedExtensions?: string[];
  maxFileSize: number; // in bytes
  downloadPath: string;
}

export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  checksum?: string;
}

export interface TransferProgress {
  fileId: string;
  fileName: string;
  totalSize: number;
  transferredSize: number;
  percentage: number;
  speed: number; // bytes per second
  remainingTime: number; // seconds
  status: 'pending' | 'transferring' | 'completed' | 'error' | 'cancelled';
}

export interface FileChunk {
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
  data: ArrayBuffer;
  checksum?: string;
}

export class FileTransferManager extends EventEmitter {
  private dataChannel: RTCDataChannel | null = null;
  private options: FileTransferOptions;
  private activeTransfers: Map<string, TransferState> = new Map();
  private incomingFiles: Map<string, IncomingFileState> = new Map();
  private transferQueue: FileTransferRequest[] = [];
  private isProcessingQueue = false;

  constructor(options: Partial<FileTransferOptions> = {}) {
    super();
    
    this.options = {
      chunkSize: 16384, // 16KB chunks
      maxConcurrentTransfers: 3,
      maxFileSize: 100 * 1024 * 1024, // 100MB
      downloadPath: './downloads',
      ...options
    };

    this.ensureDownloadDirectory();
  }

  private ensureDownloadDirectory(): void {
    if (!fs.existsSync(this.options.downloadPath)) {
      fs.mkdirSync(this.options.downloadPath, { recursive: true });
    }
  }

  // Set up data channel for file transfer
  public setDataChannel(dataChannel: RTCDataChannel): void {
    this.dataChannel = dataChannel;
    
    dataChannel.onmessage = (event) => {
      this.handleIncomingMessage(event.data);
    };

    dataChannel.onopen = () => {
      console.log('File transfer data channel opened');
      this.emit('channelReady');
    };

    dataChannel.onclose = () => {
      console.log('File transfer data channel closed');
      this.emit('channelClosed');
    };

    dataChannel.onerror = (error) => {
      console.error('File transfer data channel error:', error);
      this.emit('channelError', error);
    };
  }

  // Send file to remote peer
  public async sendFile(filePath: string): Promise<string> {
    try {
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
        throw new Error('Data channel not ready');
      }

      const metadata = await this.getFileMetadata(filePath);
      
      // Check file size limit
      if (metadata.size > this.options.maxFileSize) {
        throw new Error(`File size exceeds limit of ${this.options.maxFileSize} bytes`);
      }

      // Check allowed extensions
      if (this.options.allowedExtensions) {
        const ext = path.extname(metadata.name).toLowerCase();
        if (!this.options.allowedExtensions.includes(ext)) {
          throw new Error(`File extension ${ext} not allowed`);
        }
      }

      const fileId = uuidv4();
      metadata.id = fileId;

      // Add to transfer queue
      const transferRequest: FileTransferRequest = {
        fileId,
        filePath,
        metadata,
        priority: 'normal'
      };

      this.transferQueue.push(transferRequest);
      this.processTransferQueue();

      return fileId;

    } catch (error) {
      console.error('Error initiating file send:', error);
      throw error;
    }
  }

  // Send file from File object (browser)
  public async sendFileObject(file: File): Promise<string> {
    try {
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
        throw new Error('Data channel not ready');
      }

      const fileId = uuidv4();
      const metadata: FileMetadata = {
        id: fileId,
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        checksum: await this.calculateChecksum(await file.arrayBuffer())
      };

      // Check file size limit
      if (metadata.size > this.options.maxFileSize) {
        throw new Error(`File size exceeds limit of ${this.options.maxFileSize} bytes`);
      }

      const transferState: TransferState = {
        fileId,
        metadata,
        fileData: await file.arrayBuffer(),
        totalChunks: Math.ceil(file.size / this.options.chunkSize),
        sentChunks: 0,
        startTime: Date.now(),
        status: 'pending'
      };

      this.activeTransfers.set(fileId, transferState);
      this.startFileTransfer(fileId);

      return fileId;

    } catch (error) {
      console.error('Error sending file object:', error);
      throw error;
    }
  }

  private async processTransferQueue(): Promise<void> {
    if (this.isProcessingQueue || this.transferQueue.length === 0) {
      return;
    }

    const activeCount = Array.from(this.activeTransfers.values())
      .filter(t => t.status === 'transferring').length;

    if (activeCount >= this.options.maxConcurrentTransfers) {
      return;
    }

    this.isProcessingQueue = true;
    const request = this.transferQueue.shift()!;

    try {
      await this.initiateFileTransfer(request);
    } catch (error) {
      console.error('Error processing transfer:', error);
      this.emit('transferError', request.fileId, error);
    }

    this.isProcessingQueue = false;
    
    // Process next in queue
    setTimeout(() => this.processTransferQueue(), 100);
  }

  private async initiateFileTransfer(request: FileTransferRequest): Promise<void> {
    const fileData = await fs.promises.readFile(request.filePath);
    const checksum = await this.calculateChecksum(fileData.buffer);
    
    request.metadata.checksum = checksum;

    const transferState: TransferState = {
      fileId: request.fileId,
      metadata: request.metadata,
      fileData: fileData.buffer,
      totalChunks: Math.ceil(request.metadata.size / this.options.chunkSize),
      sentChunks: 0,
      startTime: Date.now(),
      status: 'pending'
    };

    this.activeTransfers.set(request.fileId, transferState);
    this.startFileTransfer(request.fileId);
  }

  private async startFileTransfer(fileId: string): Promise<void> {
    const transferState = this.activeTransfers.get(fileId);
    if (!transferState) return;

    // Send file metadata first
    const metadataMessage = {
      type: 'file-metadata',
      data: transferState.metadata
    };

    this.sendMessage(metadataMessage);
    transferState.status = 'transferring';

    // Start sending chunks
    this.sendNextChunk(fileId);
  }

  private sendNextChunk(fileId: string): void {
    const transferState = this.activeTransfers.get(fileId);
    if (!transferState || transferState.status !== 'transferring') return;

    const { sentChunks, totalChunks, fileData } = transferState;
    
    if (sentChunks >= totalChunks) {
      this.completeTransfer(fileId);
      return;
    }

    const chunkStart = sentChunks * this.options.chunkSize;
    const chunkEnd = Math.min(chunkStart + this.options.chunkSize, fileData.byteLength);
    const chunkData = fileData.slice(chunkStart, chunkEnd);

    const chunk: FileChunk = {
      fileId,
      chunkIndex: sentChunks,
      totalChunks,
      data: chunkData,
      checksum: this.calculateChunkChecksum(chunkData)
    };

    const chunkMessage = {
      type: 'file-chunk',
      data: chunk
    };

    this.sendMessage(chunkMessage);
    transferState.sentChunks++;

    // Update progress
    this.updateTransferProgress(fileId);

    // Send next chunk with slight delay to avoid overwhelming the channel
    setTimeout(() => this.sendNextChunk(fileId), 1);
  }

  private completeTransfer(fileId: string): void {
    const transferState = this.activeTransfers.get(fileId);
    if (!transferState) return;

    transferState.status = 'completed';
    
    // Send completion message
    this.sendMessage({
      type: 'file-complete',
      data: { fileId, checksum: transferState.metadata.checksum }
    });

    this.emit('transferComplete', fileId);
    this.updateTransferProgress(fileId);

    // Clean up after delay
    setTimeout(() => {
      this.activeTransfers.delete(fileId);
    }, 5000);

    // Process next in queue
    this.processTransferQueue();
  }

  private handleIncomingMessage(data: any): void {
    try {
      let message;
      
      if (typeof data === 'string') {
        message = JSON.parse(data);
      } else if (data instanceof ArrayBuffer) {
        // Handle binary chunk data
        const view = new DataView(data);
        const headerLength = view.getUint32(0);
        const header = JSON.parse(new TextDecoder().decode(data.slice(4, 4 + headerLength)));
        const chunkData = data.slice(4 + headerLength);
        
        message = {
          type: 'file-chunk',
          data: {
            ...header,
            data: chunkData
          }
        };
      }

      switch (message.type) {
        case 'file-metadata':
          this.handleFileMetadata(message.data);
          break;
        case 'file-chunk':
          this.handleFileChunk(message.data);
          break;
        case 'file-complete':
          this.handleFileComplete(message.data);
          break;
        case 'chunk-ack':
          this.handleChunkAck(message.data);
          break;
        default:
          console.warn('Unknown file transfer message type:', message.type);
      }
    } catch (error) {
      console.error('Error handling incoming message:', error);
    }
  }

  private handleFileMetadata(metadata: FileMetadata): void {
    console.log('Receiving file:', metadata.name);

    const incomingFile: IncomingFileState = {
      metadata,
      receivedChunks: new Map(),
      totalChunks: Math.ceil(metadata.size / this.options.chunkSize),
      receivedSize: 0,
      startTime: Date.now(),
      status: 'receiving'
    };

    this.incomingFiles.set(metadata.id, incomingFile);
    this.emit('fileReceiveStart', metadata);
  }

  private handleFileChunk(chunk: FileChunk): void {
    const incomingFile = this.incomingFiles.get(chunk.fileId);
    if (!incomingFile) {
      console.error('Received chunk for unknown file:', chunk.fileId);
      return;
    }

    // Verify chunk checksum
    if (chunk.checksum && chunk.checksum !== this.calculateChunkChecksum(chunk.data)) {
      console.error('Chunk checksum mismatch');
      return;
    }

    incomingFile.receivedChunks.set(chunk.chunkIndex, chunk.data);
    incomingFile.receivedSize += chunk.data.byteLength;

    // Send acknowledgment
    this.sendMessage({
      type: 'chunk-ack',
      data: { fileId: chunk.fileId, chunkIndex: chunk.chunkIndex }
    });

    // Update progress
    this.updateReceiveProgress(chunk.fileId);

    // Check if file is complete
    if (incomingFile.receivedChunks.size === incomingFile.totalChunks) {
      this.assembleReceivedFile(chunk.fileId);
    }
  }

  private async assembleReceivedFile(fileId: string): Promise<void> {
    const incomingFile = this.incomingFiles.get(fileId);
    if (!incomingFile) return;

    try {
      // Assemble chunks in order
      const assembledData = new Uint8Array(incomingFile.metadata.size);
      let offset = 0;

      for (let i = 0; i < incomingFile.totalChunks; i++) {
        const chunkData = incomingFile.receivedChunks.get(i);
        if (!chunkData) {
          throw new Error(`Missing chunk ${i}`);
        }
        
        assembledData.set(new Uint8Array(chunkData), offset);
        offset += chunkData.byteLength;
      }

      // Verify file checksum
      const fileChecksum = await this.calculateChecksum(assembledData.buffer);
      if (incomingFile.metadata.checksum && fileChecksum !== incomingFile.metadata.checksum) {
        throw new Error('File checksum verification failed');
      }

      // Save file
      const filePath = path.join(this.options.downloadPath, incomingFile.metadata.name);
      await fs.promises.writeFile(filePath, assembledData);

      incomingFile.status = 'completed';
      console.log('File received successfully:', filePath);
      
      this.emit('fileReceiveComplete', {
        fileId,
        filePath,
        metadata: incomingFile.metadata
      });

      // Clean up
      setTimeout(() => {
        this.incomingFiles.delete(fileId);
      }, 5000);

    } catch (error) {
      console.error('Error assembling received file:', error);
      incomingFile.status = 'error';
      this.emit('fileReceiveError', fileId, error);
    }
  }

  private handleFileComplete(data: { fileId: string; checksum: string }): void {
    console.log('File transfer completed:', data.fileId);
  }

  private handleChunkAck(data: { fileId: string; chunkIndex: number }): void {
    // Handle chunk acknowledgment for flow control
  }

  private sendMessage(message: any): void {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(message));
    }
  }

  private updateTransferProgress(fileId: string): void {
    const transferState = this.activeTransfers.get(fileId);
    if (!transferState) return;

    const elapsed = Date.now() - transferState.startTime;
    const transferredSize = transferState.sentChunks * this.options.chunkSize;
    const percentage = (transferredSize / transferState.metadata.size) * 100;
    const speed = transferredSize / (elapsed / 1000);
    const remainingSize = transferState.metadata.size - transferredSize;
    const remainingTime = speed > 0 ? remainingSize / speed : 0;

    const progress: TransferProgress = {
      fileId,
      fileName: transferState.metadata.name,
      totalSize: transferState.metadata.size,
      transferredSize,
      percentage: Math.min(percentage, 100),
      speed,
      remainingTime,
      status: transferState.status
    };

    this.emit('transferProgress', progress);
  }

  private updateReceiveProgress(fileId: string): void {
    const incomingFile = this.incomingFiles.get(fileId);
    if (!incomingFile) return;

    const elapsed = Date.now() - incomingFile.startTime;
    const percentage = (incomingFile.receivedSize / incomingFile.metadata.size) * 100;
    const speed = incomingFile.receivedSize / (elapsed / 1000);
    const remainingSize = incomingFile.metadata.size - incomingFile.receivedSize;
    const remainingTime = speed > 0 ? remainingSize / speed : 0;

    const progress: TransferProgress = {
      fileId,
      fileName: incomingFile.metadata.name,
      totalSize: incomingFile.metadata.size,
      transferredSize: incomingFile.receivedSize,
      percentage: Math.min(percentage, 100),
      speed,
      remainingTime,
      status: incomingFile.status
    };

    this.emit('receiveProgress', progress);
  }

  private async getFileMetadata(filePath: string): Promise<FileMetadata> {
    const stats = await fs.promises.stat(filePath);
    const name = path.basename(filePath);
    
    return {
      id: '',
      name,
      size: stats.size,
      type: this.getMimeType(name),
      lastModified: stats.mtime.getTime()
    };
  }

  private getMimeType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      '.txt': 'text/plain',
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.mp4': 'video/mp4',
      '.zip': 'application/zip',
      '.json': 'application/json'
    };
    
    return mimeTypes[ext] || 'application/octet-stream';
  }

  private async calculateChecksum(data: ArrayBuffer): Promise<string> {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from(data));
    return hash.digest('hex');
  }

  private calculateChunkChecksum(data: ArrayBuffer): string {
    const crypto = require('crypto');
    const hash = crypto.createHash('md5');
    hash.update(Buffer.from(data));
    return hash.digest('hex');
  }

  // Cancel ongoing transfer
  public cancelTransfer(fileId: string): void {
    const transferState = this.activeTransfers.get(fileId);
    if (transferState) {
      transferState.status = 'cancelled';
      this.emit('transferCancelled', fileId);
    }

    const incomingFile = this.incomingFiles.get(fileId);
    if (incomingFile) {
      incomingFile.status = 'cancelled';
      this.emit('receiveCancelled', fileId);
    }
  }

  // Get all active transfers
  public getActiveTransfers(): TransferProgress[] {
    const transfers: TransferProgress[] = [];
    
    for (const [fileId, state] of this.activeTransfers) {
      const elapsed = Date.now() - state.startTime;
      const transferredSize = state.sentChunks * this.options.chunkSize;
      const speed = transferredSize / (elapsed / 1000);
      
      transfers.push({
        fileId,
        fileName: state.metadata.name,
        totalSize: state.metadata.size,
        transferredSize,
        percentage: (transferredSize / state.metadata.size) * 100,
        speed,
        remainingTime: speed > 0 ? (state.metadata.size - transferredSize) / speed : 0,
        status: state.status
      });
    }
    
    return transfers;
  }

  // Clean up resources
  public cleanup(): void {
    this.activeTransfers.clear();
    this.incomingFiles.clear();
    this.transferQueue = [];
    this.dataChannel = null;
  }
}

// Supporting interfaces
interface TransferState {
  fileId: string;
  metadata: FileMetadata;
  fileData: ArrayBuffer;
  totalChunks: number;
  sentChunks: number;
  startTime: number;
  status: 'pending' | 'transferring' | 'completed' | 'error' | 'cancelled';
}

interface IncomingFileState {
  metadata: FileMetadata;
  receivedChunks: Map<number, ArrayBuffer>;
  totalChunks: number;
  receivedSize: number;
  startTime: number;
  status: 'receiving' | 'completed' | 'error' | 'cancelled';
}

interface FileTransferRequest {
  fileId: string;
  filePath: string;
  metadata: FileMetadata;
  priority: 'low' | 'normal' | 'high';
}