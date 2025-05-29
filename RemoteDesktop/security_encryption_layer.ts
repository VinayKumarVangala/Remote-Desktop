// security/EncryptionManager.ts
import * as crypto from 'crypto';

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface EncryptedData {
  data: string;
  iv: string;
  authTag: string;
  timestamp: number;
}

export interface SessionKeys {
  encryptionKey: Buffer;
  macKey: Buffer;
  keyId: string;
}

export interface SecurityConfig {
  keySize: number;
  algorithm: string;
  hashAlgorithm: string;
  sessionTimeout: number; // in milliseconds
  maxMessageAge: number; // in milliseconds
}

export class EncryptionManager {
  private sessionKeys: SessionKeys | null = null;
  private peerPublicKey: string | null = null;
  private myKeyPair: KeyPair | null = null;
  private config: SecurityConfig;
  private messageCounter = 0;
  private lastKeyRotation = 0;

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = {
      keySize: 32, // 256-bit keys
      algorithm: 'aes-256-gcm',
      hashAlgorithm: 'sha256',
      sessionTimeout: 3600000, // 1 hour
      maxMessageAge: 300000, // 5 minutes
      ...config
    };
  }

  // Generate RSA key pair for initial key exchange
  public generateKeyPair(): KeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    });

    this.myKeyPair = { publicKey, privateKey };
    return this.myKeyPair;
  }

  // Set peer's public key for key exchange
  public setPeerPublicKey(publicKey: string): void {
    this.peerPublicKey = publicKey;
  }

  // Generate and encrypt session keys
  public generateSessionKeys(): { encryptedKeys: string; keyId: string } {
    if (!this.peerPublicKey) {
      throw new Error('Peer public key not set');
    }

    // Generate random session keys
    const encryptionKey = crypto.randomBytes(this.config.keySize);
    const macKey = crypto.randomBytes(this.config.keySize);
    const keyId = crypto.randomBytes(16).toString('hex');

    this.sessionKeys = {
      encryptionKey,
      macKey,
      keyId
    };

    // Combine keys for transmission
    const combinedKeys = Buffer.concat([
      Buffer.from(keyId, 'hex'),
      encryptionKey,
      macKey,
      Buffer.from(Date.now().toString())
    ]);

    // Encrypt with peer's public key
    const encryptedKeys = crypto.publicEncrypt(
      {
        key: this.peerPublicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      combinedKeys
    ).toString('base64');

    this.lastKeyRotation = Date.now();
    console.log('Session keys generated and encrypted');

    return { encryptedKeys, keyId };
  }

  // Decrypt received session keys
  public decryptSessionKeys(encryptedKeys: string): string {
    if (!this.myKeyPair?.privateKey) {
      throw new Error('Private key not available');
    }

    try {
      // Decrypt with our private key
      const decryptedData = crypto.privateDecrypt(
        {
          key: this.myKeyPair.privateKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256'
        },
        Buffer.from(encryptedKeys, 'base64')
      );

      // Extract components
      const keyId = decryptedData.slice(0, 16).toString('hex');
      const encryptionKey = decryptedData.slice(16, 16 + this.config.keySize);
      const macKey = decryptedData.slice(16 + this.config.keySize, 16 + (2 * this.config.keySize));
      const timestamp = parseInt(decryptedData.slice(16 + (2 * this.config.keySize)).toString());

      // Verify timestamp (prevent replay attacks)
      const now = Date.now();
      if (now - timestamp > this.config.maxMessageAge) {
        throw new Error('Session keys too old');
      }

      this.sessionKeys = {
        encryptionKey,
        macKey,
        keyId
      };

      this.lastKeyRotation = Date.now();
      console.log('Session keys decrypted and set');

      return keyId;

    } catch (error) {
      console.error('Failed to decrypt session keys:', error);
      throw new Error('Key decryption failed');
    }
  }

  // Encrypt data with session keys
  public encryptData(data: string | Buffer): EncryptedData {
    if (!this.sessionKeys) {
      throw new Error('Session keys not established');
    }

    const plaintext = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const timestamp = Date.now();

    // Create cipher
    const cipher = crypto.createCipherGCM(this.config.algorithm, this.sessionKeys.encryptionKey);
    cipher.setIVLength(12);
    cipher.update(iv);

    // Add timestamp to AAD (Additional Authenticated Data)
    const aad = Buffer.from(timestamp.toString());
    cipher.setAAD(aad);

    // Encrypt
    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    return {
      data: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      timestamp
    };
  }

  // Decrypt data with session keys
  public decryptData(encryptedData: EncryptedData): Buffer {
    if (!this.sessionKeys) {
      throw new Error('Session keys not established');
    }

    // Verify message age
    const now = Date.now();
    if (now - encryptedData.timestamp > this.config.maxMessageAge) {
      throw new Error('Message too old');
    }

    try {
      const data = Buffer.from(encryptedData.data, 'base64');
      const iv = Buffer.from(encryptedData.iv, 'base64');
      const authTag = Buffer.from(encryptedData.authTag, 'base64');

      // Create decipher
      const decipher = crypto.createDecipherGCM(this.config.algorithm, this.sessionKeys.encryptionKey);
      decipher.setIVLength(12);
      decipher.update(iv);
      decipher.setAuthTag(authTag);

      // Set AAD
      const aad = Buffer.from(encryptedData.timestamp.toString());
      decipher.setAAD(aad);

      // Decrypt
      const decrypted = Buffer.concat([
        decipher.update(data),
        decipher.final()
      ]);

      return decrypted;

    } catch (error) {
      console.error('Decryption failed:', error);
      throw new Error('Decryption failed - possible tampering');
    }
  }

  // Generate HMAC for message authentication
  public generateMAC(data: string | Buffer): string {
    if (!this.sessionKeys) {
      throw new Error('Session keys not established');
    }

    const message = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const hmac = crypto.createHmac(this.config.hashAlgorithm, this.sessionKeys.macKey);
    hmac.update(message);
    return hmac.digest('hex');
  }

  // Verify HMAC
  public verifyMAC(data: string | Buffer, expectedMAC: string): boolean {
    const calculatedMAC = this.generateMAC(data);
    return crypto.timingSafeEqual(
      Buffer.from(calculatedMAC, 'hex'),
      Buffer.from(expectedMAC, 'hex')
    );
  }

  // Check if session keys need rotation
  public needsKeyRotation(): boolean {
    if (!this.sessionKeys) return true;
    
    const elapsed = Date.now() - this.lastKeyRotation;
    return elapsed > this.config.sessionTimeout;
  }

  // Rotate session keys
  public rotateKeys(): { encryptedKeys: string; keyId: string } {
    console.log('Rotating session keys...');
    return this.generateSessionKeys();
  }

  // Secure key derivation function
  public deriveKey(password: string, salt: Buffer, iterations = 100000): Buffer {
    return crypto.pbkdf2Sync(password, salt, iterations, this.config.keySize, this.config.hashAlgorithm);
  }

  // Generate secure random room ID
  public generateSecureRoomId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  // Hash password for authentication
  public hashPassword(password: string, salt?: Buffer): { hash: string; salt: string } {
    const actualSalt = salt || crypto.randomBytes(32);
    const hash = crypto.pbkdf2Sync(password, actualSalt, 100000, 64, 'sha512');
    
    return {
      hash: hash.toString('hex'),
      salt: actualSalt.toString('hex')
    };
  }

  // Verify password
  public verifyPassword(password: string, hash: string, salt: string): boolean {
    const saltBuffer = Buffer.from(salt, 'hex');
    const computedHash = crypto.pbkdf2Sync(password, saltBuffer, 100000, 64, 'sha512');
    
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      computedHash
    );
  }

  // Clean up sensitive data
  public cleanup(): void {
    if (this.sessionKeys) {
      this.sessionKeys.encryptionKey.fill(0);
      this.sessionKeys.macKey.fill(0);
      this.sessionKeys = null;
    }
    
    this.myKeyPair = null;
    this.peerPublicKey = null;
    this.messageCounter = 0;
    this.lastKeyRotation = 0;
  }
}

// Secure WebRTC wrapper
export class SecureWebRTCManager {
  private encryptionManager: EncryptionManager;
  private dataChannel: RTCDataChannel | null = null;
  private isSecureChannelEstablished = false;

  constructor(encryptionManager: EncryptionManager) {
    this.encryptionManager = encryptionManager;
  }

  // Set up secure data channel
  public setupSecureChannel(dataChannel: RTCDataChannel): void {
    this.dataChannel = dataChannel;

    dataChannel.onmessage = (event) => {
      this.handleSecureMessage(event.data);
    };

    dataChannel.onopen = () => {
      console.log('Secure data channel opened');
      this.initiateKeyExchange();
    };
  }

  // Initiate key exchange
  private async initiateKeyExchange(): Promise<void> {
    try {
      // Generate our key pair
      const keyPair = this.encryptionManager.generateKeyPair();
      
      // Send our public key
      const keyExchangeMessage = {
        type: 'key-exchange-init',
        publicKey: keyPair.publicKey,
        timestamp: Date.now()
      };

      this.sendRawMessage(keyExchangeMessage);
      console.log('Key exchange initiated');

    } catch (error) {
      console.error('Key exchange initiation failed:', error);
    }
  }

  // Handle incoming secure messages
  private handleSecureMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'key-exchange-init':
          this.handleKeyExchangeInit(message);
          break;
        case 'key-exchange-response':
          this.handleKeyExchangeResponse(message);
          break;
        case 'key-exchange-complete':
          this.handleKeyExchangeComplete(message);
          break;
        case 'encrypted-message':
          this.handleEncryptedMessage(message);
          break;
        case 'key-rotation':
          this.handleKeyRotation(message);
          break;
        default:
          console.warn('Unknown secure message type:', message.type);
      }
    } catch (error) {
      console.error('Error handling secure message:', error);
    }
  }

  private async handleKeyExchangeInit(message: any): Promise<void> {
    try {
      // Set peer's public key
      this.encryptionManager.setPeerPublicKey(message.publicKey);
      
      // Generate our key pair and session keys
      const myKeyPair = this.encryptionManager.generateKeyPair();
      const { encryptedKeys, keyId } = this.encryptionManager.generateSessionKeys();

      // Send response with our public key and encrypted session keys
      const response = {
        type: 'key-exchange-response',
        publicKey: myKeyPair.publicKey,
        encryptedKeys,
        keyId,
        timestamp: Date.now()
      };

      this.sendRawMessage(response);
      console.log('Key exchange response sent');

    } catch (error) {
      console.error('Key exchange response failed:', error);
    }
  }

  private async handleKeyExchangeResponse(message: any): Promise<void> {
    try {
      // Set peer's public key and decrypt session keys
      this.encryptionManager.setPeerPublicKey(message.publicKey);
      const keyId = this.encryptionManager.decryptSessionKeys(message.encryptedKeys);

      // Send completion confirmation
      const completion = {
        type: 'key-exchange-complete',
        keyId,
        timestamp: Date.now()
      };

      this.sendRawMessage(completion);
      this.isSecureChannelEstablished = true;
      console.log('Key exchange completed');

    } catch (error) {
      console.error('Key exchange completion failed:', error);
    }
  }

  private handleKeyExchangeComplete(message: any): void {
    this.isSecureChannelEstablished = true;
    console.log('Secure channel established');
  }

  private handleEncryptedMessage(message: any): void {
    try {
      if (!this.isSecureChannelEstablished) {
        console.warn('Received encrypted message before secure channel established');
        return;
      }

      // Decrypt the message
      const decryptedData = this.encryptionManager.decryptData(message.encryptedData);
      const originalMessage = JSON.parse(decryptedData.toString('utf8'));

      // Emit decrypted message
      this.onSecureMessage?.(originalMessage);

    } catch (error) {
      console.error('Failed to decrypt message:', error);
    }
  }

  private handleKeyRotation(message: any): void {
    try {
      // Decrypt new session keys
      const keyId = this.encryptionManager.decryptSessionKeys(message.encryptedKeys);
      console.log('Session keys rotated:', keyId);

    } catch (error) {
      console.error('Key rotation failed:', error);
    }
  }

  // Send encrypted message
  public sendSecureMessage(message: any): void {
    if (!this.isSecureChannelEstablished) {
      console.warn('Secure channel not established yet');
      return;
    }

    try {
      // Encrypt the message
      const messageStr = JSON.stringify(message);
      const encryptedData = this.encryptionManager.encryptData(messageStr);

      const secureMessage = {
        type: 'encrypted-message',
        encryptedData,
        timestamp: Date.now()
      };

      this.sendRawMessage(secureMessage);

    } catch (error) {
      console.error('Failed to send secure message:', error);
    }
  }

  // Send raw (unencrypted) message
  private sendRawMessage(message: any): void {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(message));
    }
  }

  // Check and perform key rotation if needed
  public checkKeyRotation(): void {
    if (this.encryptionManager.needsKeyRotation()) {
      this.performKeyRotation();
    }
  }

  private performKeyRotation(): void {
    try {
      const { encryptedKeys, keyId } = this.encryptionManager.rotateKeys();
      
      const rotationMessage = {
        type: 'key-rotation',
        encryptedKeys,
        keyId,
        timestamp: Date.now()
      };

      this.sendRawMessage(rotationMessage);
      console.log('Key rotation performed');

    } catch (error) {
      console.error('Key rotation failed:', error);
    }
  }

  // Event handler for secure messages
  public onSecureMessage?: (message: any) => void;

  // Check if secure channel is ready
  public isSecureChannelReady(): boolean {
    return this.isSecureChannelEstablished;
  }

  // Clean up
  public cleanup(): void {
    this.encryptionManager.cleanup();
    this.dataChannel = null;
    this.isSecureChannelEstablished = false;
  }
}

// Authentication manager for room access
export class AuthenticationManager {
  private encryptionManager: EncryptionManager;
  private authorizedUsers: Map<string, { hash: string; salt: string; permissions: string[] }> = new Map();

  constructor(encryptionManager: EncryptionManager) {
    this.encryptionManager = encryptionManager;
  }

  // Add authorized user
  public addUser(username: string, password: string, permissions: string[] = ['view']): void {
    const { hash, salt } = this.encryptionManager.hashPassword(password);
    
    this.authorizedUsers.set(username, {
      hash,
      salt,
      permissions
    });

    console.log(`User ${username} added with permissions:`, permissions);
  }

  // Authenticate user
  public authenticateUser(username: string, password: string): { success: boolean; permissions?: string[] } {
    const user = this.authorizedUsers.get(username);
    if (!user) {
      return { success: false };
    }

    const isValid = this.encryptionManager.verifyPassword(password, user.hash, user.salt);
    
    if (isValid) {
      return { success: true, permissions: user.permissions };
    }
    
    return { success: false };
  }

  // Generate secure session token
  public generateSessionToken(username: string): string {
    const payload = {
      username,
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex')
    };

    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  // Verify session token
  public verifySessionToken(token: string, maxAge = 3600000): { valid: boolean; username?: string } {
    try {
      const payload = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      const now = Date.now();
      
      if (now - payload.timestamp > maxAge) {
        return { valid: false };
      }

      return { valid: true, username: payload.username };

    } catch (error) {
      return { valid: false };
    }
  }
}