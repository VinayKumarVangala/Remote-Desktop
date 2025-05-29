// mobile-controls.js - Mobile Touch Controls and Gesture Handling
class MobileControls {
  constructor(remoteCanvas) {
    this.canvas = remoteCanvas;
    this.ctx = remoteCanvas.getContext('2d');
    this.isEnabled = this.isMobileDevice();
    this.touchState = {
      touches: new Map(),
      lastTap: 0,
      isScrolling: false,
      isPinching: false,
      isDragging: false,
      virtualKeyboard: false
    };
    
    // Gesture recognition
    this.gestures = {
      doubleTapThreshold: 300,   // ms
      longPressThreshold: 500,   // ms
      pinchThreshold: 10,        // pixels
      swipeThreshold: 50,        // pixels
      dragThreshold: 5           // pixels
    };
    
    // Virtual controls state
    this.virtualControls = {
      visible: false,
      mode: 'mouse', // 'mouse', 'touch', 'keyboard'
      position: { x: 20, y: 20 },
      size: { width: 80, height: 80 }
    };
    
    // Scale and offset for zoom/pan
    this.viewport = {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      minScale: 0.25,
      maxScale: 4.0
    };
    
    if (this.isEnabled) {
      this.initializeMobileControls();
    }
  }
  
  isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
           (navigator.maxTouchPoints && navigator.maxTouchPoints > 1);
  }
  
  initializeMobileControls() {
    console.log('[Mobile] Initializing mobile controls');
    
    // Prevent default touch behaviors
    this.canvas.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: false });
    this.canvas.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
    this.canvas.addEventListener('touchend', this.handleTouchEnd.bind(this), { passive: false });
    this.canvas.addEventListener('touchcancel', this.handleTouchCancel.bind(this), { passive: false });
    
    // Handle device orientation
    window.addEventListener('orientationchange', this.handleOrientationChange.bind(this));
    window.addEventListener('resize', this.handleResize.bind(this));
    
    // Virtual keyboard detection
    window.addEventListener('resize', this.detectVirtualKeyboard.bind(this));
    
    // Create virtual control overlay
    this.createVirtualControls();
    
    // Setup haptic feedback if available
    this.setupHapticFeedback();
    
    console.log('[Mobile] Mobile controls initialized');
  }
  
  handleTouchStart(event) {
    event.preventDefault();
    
    const touches = Array.from(event.changedTouches);
    const now = Date.now();
    
    touches.forEach(touch => {
      const touchInfo = {
        id: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        currentX: touch.clientX,
        currentY: touch.clientY,
        startTime: now,
        moved: false
      };
      
      this.touchState.touches.set(touch.identifier, touchInfo);
    });
    
    // Determine gesture type based on number of touches
    const touchCount = this.touchState.touches.size;
    
    if (touchCount === 1) {
      this.handleSingleTouchStart(touches[0]);
    } else if (touchCount === 2) {
      this.handleDoubleTouchStart();
    } else if (touchCount >= 3) {
      this.handleMultiTouchStart();
    }
  }
  
  handleSingleTouchStart(touch) {
    const now = Date.now();
    const timeSinceLastTap = now - this.touchState.lastTap;
    
    // Check for double tap
    if (timeSinceLastTap < this.gestures.doubleTapThreshold) {
      this.handleDoubleTap(touch);
      return;
    }
    
    this.touchState.lastTap = now;
    
    // Start long press timer
    this.longPressTimer = setTimeout(() => {
      this.handleLongPress(touch);
    }, this.gestures.longPressThreshold);
    
    // Convert touch coordinates to remote coordinates
    const remoteCoords = this.touchToRemoteCoordinates(touch.clientX, touch.clientY);
    this.sendMouseEvent('mousedown', remoteCoords.x, remoteCoords.y, 'left');
  }
  
  handleDoubleTouchStart() {
    console.log('[Mobile] Two-finger gesture detected');
    this.touchState.isPinching = true;
    
    // Clear any pending single touch gestures
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    
    // Calculate initial pinch distance
    const touches = Array.from(this.touchState.touches.values());
    if (touches.length >= 2) {
      const dx = touches[0].currentX - touches[1].currentX;
      const dy = touches[0].currentY - touches[1].currentY;
      this.initialPinchDistance = Math.sqrt(dx * dx + dy * dy);
    }
  }
  
  handleMultiTouchStart() {
    console.log('[Mobile] Multi-touch gesture detected');
    // Show context menu or special controls
    this.showVirtualControls();
  }
  
  handleTouchMove(event) {
    event.preventDefault();
    
    const touches = Array.from(event.changedTouches);
    
    touches.forEach(touch => {
      const touchInfo = this.touchState.touches.get(touch.identifier);
      if (!touchInfo) return;
      
      const dx = touch.clientX - touchInfo.startX;
      const dy = touch.clientY - touchInfo.startY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Update touch info
      touchInfo.currentX = touch.clientX;
      touchInfo.currentY = touch.clientY;
      
      // Mark as moved if threshold exceeded
      if (distance > this.gestures.dragThreshold) {
        touchInfo.moved = true;
        
        // Clear long press timer if moving
        if (this.longPressTimer) {
          clearTimeout(this.longPressTimer);
          this.longPressTimer = null;
        }
      }
    });
    
    const touchCount = this.touchState.touches.size;
    
    if (touchCount === 1 && !this.touchState.isPinching) {
      this.handleSingleTouchMove(touches[0]);
    } else if (touchCount === 2) {
      this.handlePinchMove();
    } else if (touchCount >= 3) {
      this.handleMultiTouchMove();
    }
  }
  
  handleSingleTouchMove(touch) {
    const touchInfo = this.touchState.touches.get(touch.identifier);
    if (!touchInfo || !touchInfo.moved) return;
    
    // Convert to remote coordinates
    const remoteCoords = this.touchToRemoteCoordinates(touch.clientX, touch.clientY);
    
    // Send mouse move event
    this.sendMouseEvent('mousemove', remoteCoords.x, remoteCoords.y);
  }
  
  handlePinchMove() {
    const touches = Array.from(this.touchState.touches.values());
    if (touches.length < 2) return;
    
    // Calculate current pinch distance
    const dx = touches[0].currentX - touches[1].currentX;
    const dy = touches[0].currentY - touches[1].currentY;
    const currentDistance = Math.sqrt(dx * dx + dy * dy);
    
    if (this.initialPinchDistance) {
      const scale = currentDistance / this.initialPinchDistance;
      this.handleZoomGesture(scale);
    }
    
    // Handle two-finger pan
    const centerX = (touches[0].currentX + touches[1].currentX) / 2;
    const centerY = (touches[0].currentY + touches[1].currentY) / 2;
    
    if (this.lastPinchCenter) {
      const panX = centerX - this.lastPinchCenter.x;
      const panY = centerY - this.lastPinchCenter.y;
      this.handlePanGesture(panX, panY);
    }
    
    this.lastPinchCenter = { x: centerX, y: centerY };
  }
  
  handleMultiTouchMove() {
    // Three-finger scroll or special gestures
    const touches = Array.from(this.touchState.touches.values());
    if (touches.length >= 3) {
      // Calculate average movement
      let avgDx = 0, avgDy = 0;
      touches.forEach(touch => {
        avgDx += touch.currentX - touch.startX;
        avgDy += touch.currentY - touch.startY;
      });
      avgDx /= touches.length;
      avgDy /= touches.length;
      
      // Send scroll events
      if (Math.abs(avgDy) > this.gestures.swipeThreshold) {
        this.sendScrollEvent(0, avgDy > 0 ? -1 : 1);
      }
    }
  }
  
  handleTouchEnd(event) {
    event.preventDefault();
    
    const touches = Array.from(event.changedTouches);
    
    touches.forEach(touch => {
      const touchInfo = this.touchState.touches.get(touch.identifier);
      if (!touchInfo) return;
      
      const duration = Date.now() - touchInfo.startTime;
      const dx = touch.clientX - touchInfo.startX;
      const dy = touch.clientY - touchInfo.startY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Handle tap if touch didn't move much
      if (!touchInfo.moved && distance < this.gestures.dragThreshold) {
        this.handleTap(touch, duration);
      } else if (distance > this.gestures.swipeThreshold) {
        this.handleSwipe(dx, dy, duration);
      }
      
      // Send mouse up event
      const remoteCoords = this.touchToRemoteCoordinates(touch.clientX, touch.clientY);
      this.sendMouseEvent('mouseup', remoteCoords.x, remoteCoords.y, 'left');
      
      this.touchState.touches.delete(touch.identifier);
    });
    
    // Reset pinch state when no touches remain
    if (this.touchState.touches.size === 0) {
      this.touchState.isPinching = false;
      this.initialPinchDistance = null;
      this.lastPinchCenter = null;
    }
    
    // Clear long press timer
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }
  
  handleTouchCancel(event) {
    // Clean up cancelled touches
    Array.from(event.changedTouches).forEach(touch => {
      this.touchState.touches.delete(touch.identifier);
    });
    
    this.touchState.isPinching = false;
    this.initialPinchDistance = null;
    this.lastPinchCenter = null;
    
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }
  
  handleTap(touch, duration) {
    console.log('[Mobile] Tap detected');
    this.triggerHapticFeedback('light');
    
    // Convert to remote coordinates and send click
    const remoteCoords = this.touchToRemoteCoordinates(touch.clientX, touch.clientY);
    this.sendMouseEvent('click', remoteCoords.x, remoteCoords.y, 'left');
  }
  
  handleDoubleTap(touch) {
    console.log('[Mobile] Double tap detected');
    this.triggerHapticFeedback('medium');
    
    // Double tap to zoom or right-click
    const remoteCoords = this.touchToRemoteCoordinates(touch.clientX, touch.clientY);
    
    if (this.viewport.scale === 1) {
      // Zoom in on double tap
      this.handleZoomGesture(2, remoteCoords.x, remoteCoords.y);
    } else {
      // Reset zoom
      this.resetViewport();
    }
  }
  
  handleLongPress(touch) {
    console.log('[Mobile] Long press detected');
    this.triggerHapticFeedback('heavy');
    
    // Long press for right-click
    const remoteCoords = this.touchToRemoteCoordinates(touch.clientX, touch.clientY);
    this.sendMouseEvent('contextmenu', remoteCoords.x, remoteCoords.y, 'right');
  }
  
  handleSwipe(dx, dy, duration) {
    const velocity = Math.sqrt(dx * dx + dy * dy) / duration;
    
    if (velocity > 0.5) { // Fast swipe
      console.log('[Mobile] Swipe detected:', { dx, dy, velocity });
      
      // Determine swipe direction
      if (Math.abs(dx) > Math.abs(dy)) {
        // Horizontal swipe
        if (dx > 0) {
          this.handleSwipeRight();
        } else {
          this.handleSwipeLeft();
        }
      } else {
        // Vertical swipe
        if (dy > 0) {
          this.handleSwipeDown();
        } else {
          this.handleSwipeUp();
        }
      }
    }
  }
  
  handleSwipeLeft() {
    // Navigate back or show menu
    this.showVirtualControls();
  }
  
  handleSwipeRight() {
    // Navigate forward or hide menu
    this.hideVirtualControls();
  }
  
  handleSwipeUp() {
    // Show virtual keyboard
    this.showVirtualKeyboard();
  }
  
  handleSwipeDown() {
    // Hide virtual keyboard or minimize
    this.hideVirtualKeyboard();
  }
  
  handleZoomGesture(scale, centerX = null, centerY = null) {
    const newScale = Math.max(this.viewport.minScale, Math.min(this.viewport.maxScale, this.viewport.scale * scale));
    
    if (newScale !== this.viewport.scale) {
      console.log('[Mobile] Zoom gesture:', { scale, newScale });
      
      // Apply zoom with center point
      if (centerX !== null && centerY !== null) {
        const scaleRatio = newScale / this.viewport.scale;
        this.viewport.offsetX = centerX - (centerX - this.viewport.offsetX) * scaleRatio;
        this.viewport.offsetY = centerY - (centerY - this.viewport.offsetY) * scaleRatio;
      }
      
      this.viewport.scale = newScale;
      this.applyViewportTransform();
      this.triggerHapticFeedback('light');
    }
  }
  
  handlePanGesture(deltaX, deltaY) {
    this.viewport.offsetX += deltaX;
    this.viewport.offsetY += deltaY;
    this.applyViewportTransform();
  }
  
  applyViewportTransform() {
    const transform = `scale(${this.viewport.scale}) translate(${this.viewport.offsetX}px, ${this.viewport.offsetY}px)`;
    this.canvas.style.transform = transform;
    this.canvas.style.transformOrigin = '0 0';
  }
  
  resetViewport() {
    this.viewport.scale = 1;
    this.viewport.offsetX = 0;
    this.viewport.offsetY = 0;
    this.applyViewportTransform();
    this.triggerHapticFeedback('medium');
  }
  
  touchToRemoteCoordinates(touchX, touchY) {
    const rect = this.canvas.getBoundingClientRect();
    const canvasX = touchX - rect.left;
    const canvasY = touchY - rect.top;
    
    // Account for viewport transform
    const remoteX = (canvasX - this.viewport.offsetX) / this.viewport.scale;
    const remoteY = (canvasY - this.viewport.offsetY) / this.viewport.scale;
    
    return { x: remoteX, y: remoteY };
  }
  
  createVirtualControls() {
    const controlsContainer = document.createElement('div');
    controlsContainer.id = 'mobile-controls';
    controlsContainer.className = 'mobile-controls-overlay';
    controlsContainer.innerHTML = `
      <div class="virtual-controls-panel">
        <button class="control-btn" data-action="right-click">⌥</button>
        <button class="control-btn" data-action="keyboard">⌨</button>
        <button class="control-btn" data-action="zoom-reset">🔍</button>
        <button class="control-btn" data-action="menu">☰</button>
      </div>
      <div class="virtual-keyboard-panel" style="display: none;">
        <div class="keyboard-row">
          <button class="key-btn" data-key="Escape">Esc</button>
          <button class="key-btn" data-key="Tab">Tab</button>
          <button class="key-btn" data-key="Enter">Enter</button>
          <button class="key-btn" data-key="Backspace">⌫</button>
        </div>
        <div class="keyboard-row">
          <button class="key-btn" data-key="Control">Ctrl</button>
          <button class="key-btn" data-key="Alt">Alt</button>
          <button class="key-btn" data-key="Shift">Shift</button>
          <button class="key-btn" data-key="Meta">Win</button>
        </div>
        <div class="keyboard-row">
          <button class="key-btn" data-key="F1">F1</button>
          <button class="key-btn" data-key="F2">F2</button>
          <button class="key-btn" data-key="F11">F11</button>
          <button class="key-btn" data-key="F12">F12</button>
        </div>
      </div>
      <div class="gesture-hint" style="display: none;">
        <div class="hint-text">Swipe up for keyboard • Long press for right-click • Pinch to zoom</div>
      </div>
    `;
    
    // Add styles
    const styles = document.createElement('style');
    styles.textContent = `
      .mobile-controls-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
        z-index: 1000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      
      .virtual-controls-panel {
        position: absolute;
        bottom: 20px;
        right: 20px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        pointer-events: auto;
        opacity: 0;
        transform: translateX(100px);
        transition: all 0.3s ease;
      }
      
      .virtual-controls-panel.visible {
        opacity: 1;
        transform: translateX(0);
      }
      
      .control-btn {
        width: 50px;
        height: 50px;
        border-radius: 25px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        border: none;
        font-size: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(10px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        cursor: pointer;
        transition: all 0.2s ease;
      }
      
      .control-btn:active {
        transform: scale(0.95);
        background: rgba(74, 144, 226, 0.9);
      }
      
      .virtual-keyboard-panel {
        position: absolute;
        bottom: 20px;
        left: 20px;
        right: 20px;
        background: rgba(0, 0, 0, 0.9);
        border-radius: 12px;
        padding: 15px;
        pointer-events: auto;
        backdrop-filter: blur(20px);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      }
      
      .keyboard-row {
        display: flex;
        gap: 8px;
        margin-bottom: 8px;
        justify-content: center;
      }
      
      .keyboard-row:last-child {
        margin-bottom: 0;
      }
      
      .key-btn {
        flex: 1;
        height: 40px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.1);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.2);
        font-size: 14px;
        cursor: pointer;
        transition: all 0.2s ease;
        max-width: 80px;
      }
      
      .key-btn:active {
        background: rgba(74, 144, 226, 0.6);
        transform: scale(0.98);
      }
      
      .gesture-hint {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        font-size: 14px;
        text-align: center;
        pointer-events: auto;
        backdrop-filter: blur(10px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      }
      
      .hint-text {
        line-height: 1.4;
      }
      
      @media (max-width: 480px) {
        .virtual-controls-panel {
          bottom: 10px;
          right: 10px;
        }
        
        .virtual-keyboard-panel {
          bottom: 10px;
          left: 10px;
          right: 10px;
          padding: 12px;
        }
        
        .control-btn {
          width: 45px;
          height: 45px;
          font-size: 16px;
        }
        
        .key-btn {
          height: 36px;
          font-size: 12px;
        }
      }
    `;
    
    document.head.appendChild(styles);
    document.body.appendChild(controlsContainer);
    
    this.controlsContainer = controlsContainer;
    this.setupVirtualControlEvents();
  }
  
  setupVirtualControlEvents() {
    const controlPanel = this.controlsContainer.querySelector('.virtual-controls-panel');
    const keyboardPanel = this.controlsContainer.querySelector('.virtual-keyboard-panel');
    
    // Control button events
    controlPanel.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      if (!action) return;
      
      switch (action) {
        case 'right-click':
          this.simulateRightClick();
          break;
        case 'keyboard':
          this.toggleVirtualKeyboard();
          break;
        case 'zoom-reset':
          this.resetViewport();
          break;
        case 'menu':
          this.toggleControlsMenu();
          break;
      }
      
      this.triggerHapticFeedback('light');
    });
    
    // Virtual keyboard events
    keyboardPanel.addEventListener('click', (e) => {
      const key = e.target.dataset.key;
      if (!key) return;
      
      this.sendKeyboardEvent(key);
      this.triggerHapticFeedback('light');
    });
  }
  
  showVirtualControls() {
    const panel = this.controlsContainer.querySelector('.virtual-controls-panel');
    panel.classList.add('visible');
    this.virtualControls.visible = true;
    
    // Auto-hide after 5 seconds
    clearTimeout(this.hideControlsTimer);
    this.hideControlsTimer = setTimeout(() => {
      this.hideVirtualControls();
    }, 5000);
  }
  
  hideVirtualControls() {
    const panel = this.controlsContainer.querySelector('.virtual-controls-panel');
    panel.classList.remove('visible');
    this.virtualControls.visible = false;
    clearTimeout(this.hideControlsTimer);
  }
  
  toggleVirtualKeyboard() {
    const panel = this.controlsContainer.querySelector('.virtual-keyboard-panel');
    const isVisible = panel.style.display !== 'none';
    
    panel.style.display = isVisible ? 'none' : 'block';
    this.touchState.virtualKeyboard = !isVisible;
    
    if (!isVisible) {
      // Auto-hide keyboard after 10 seconds of inactivity
      clearTimeout(this.hideKeyboardTimer);
      this.hideKeyboardTimer = setTimeout(() => {
        this.hideVirtualKeyboard();
      }, 10000);
    }
  }
  
  showVirtualKeyboard() {
    const panel = this.controlsContainer.querySelector('.virtual-keyboard-panel');
    panel.style.display = 'block';
    this.touchState.virtualKeyboard = true;
  }
  
  hideVirtualKeyboard() {
    const panel = this.controlsContainer.querySelector('.virtual-keyboard-panel');
    panel.style.display = 'none';
    this.touchState.virtualKeyboard = false;
    clearTimeout(this.hideKeyboardTimer);
  }
  
  toggleControlsMenu() {
    if (this.virtualControls.visible) {
      this.hideVirtualControls();
    } else {
      this.showVirtualControls();
    }
  }
  
  simulateRightClick() {
    // Get center of screen for right-click
    const centerX = this.canvas.width / 2;
    const centerY = this.canvas.height / 2;
    
    this.sendMouseEvent('contextmenu', centerX, centerY, 'right');
  }
  
  showGestureHint(message, duration = 2000) {
    const hint = this.controlsContainer.querySelector('.gesture-hint');
    const hintText = hint.querySelector('.hint-text');
    
    hintText.textContent = message;
    hint.style.display = 'block';
    
    setTimeout(() => {
      hint.style.display = 'none';
    }, duration);
  }
  
  handleOrientationChange() {
    console.log('[Mobile] Orientation changed');
    
    // Reset viewport on orientation change
    setTimeout(() => {
      this.resetViewport();
      this.adjustCanvasSize();
    }, 100);
    
    this.showGestureHint('Screen rotated - controls adjusted');
  }
  
  handleResize() {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
    }
    
    this.resizeTimer = setTimeout(() => {
      this.adjustCanvasSize();
      this.detectVirtualKeyboard();
    }, 100);
  }
  
  adjustCanvasSize() {
    const rect = this.canvas.getBoundingClientRect();
    const devicePixelRatio = window.devicePixelRatio || 1;
    
    // Adjust canvas for high-DPI displays
    this.canvas.width = rect.width * devicePixelRatio;
    this.canvas.height = rect.height * devicePixelRatio;
    
    this.ctx.scale(devicePixelRatio, devicePixelRatio);
  }
  
  detectVirtualKeyboard() {
    const windowHeight = window.innerHeight;
    const documentHeight = document.documentElement.clientHeight;
    
    // Virtual keyboard likely open if window height is significantly smaller
    const keyboardOpen = windowHeight < documentHeight * 0.75;
    
    if (keyboardOpen !== this.touchState.virtualKeyboard) {
      this.touchState.virtualKeyboard = keyboardOpen;
      
      if (keyboardOpen) {
        console.log('[Mobile] Virtual keyboard detected');
        // Adjust layout for keyboard
        this.adjustForVirtualKeyboard();
      } else {
        console.log('[Mobile] Virtual keyboard hidden');
        this.resetLayoutForKeyboard();
      }
    }
  }
  
  adjustForVirtualKeyboard() {
    // Move controls up when keyboard is open
    const controlPanel = this.controlsContainer.querySelector('.virtual-controls-panel');
    controlPanel.style.bottom = '120px';
  }
  
  resetLayoutForKeyboard() {
    // Reset control position
    const controlPanel = this.controlsContainer.querySelector('.virtual-controls-panel');
    controlPanel.style.bottom = '20px';
  }
  
  setupHapticFeedback() {
    // Check if haptic feedback is available
    this.hapticSupported = 'vibrate' in navigator;
    console.log('[Mobile] Haptic feedback:', this.hapticSupported ? 'supported' : 'not supported');
  }
  
  triggerHapticFeedback(intensity = 'light') {
    if (!this.hapticSupported) return;
    
    const patterns = {
      light: [10],
      medium: [20],
      heavy: [30],
      double: [10, 50, 10],
      success: [10, 100, 10, 100, 10]
    };
    
    const pattern = patterns[intensity] || patterns.light;
    navigator.vibrate(pattern);
  }
  
  sendMouseEvent(type, x, y, button = 'left') {
    // Send mouse event to remote desktop
    if (window.remoteDesktop && window.remoteDesktop.sendMouseEvent) {
      window.remoteDesktop.sendMouseEvent({
        type: type,
        x: Math.round(x),
        y: Math.round(y),
        button: button,
        timestamp: Date.now()
      });
    }
  }
  
  sendScrollEvent(deltaX, deltaY) {
    // Send scroll event to remote desktop
    if (window.remoteDesktop && window.remoteDesktop.sendScrollEvent) {
      window.remoteDesktop.sendScrollEvent({
        deltaX: deltaX,
        deltaY: deltaY,
        timestamp: Date.now()
      });
    }
  }
  
  sendKeyboardEvent(key, type = 'keydown') {
    // Send keyboard event to remote desktop
    if (window.remoteDesktop && window.remoteDesktop.sendKeyboardEvent) {
      window.remoteDesktop.sendKeyboardEvent({
        type: type,
        key: key,
        timestamp: Date.now()
      });
      
      // Also send keyup for complete key press
      if (type === 'keydown') {
        setTimeout(() => {
          this.sendKeyboardEvent(key, 'keyup');
        }, 50);
      }
    }
  }
  
  // Public API methods
  enable() {
    this.isEnabled = true;
    if (this.isMobileDevice()) {
      this.initializeMobileControls();
    }
  }
  
  disable() {
    this.isEnabled = false;
    this.hideVirtualControls();
    this.hideVirtualKeyboard();
  }
  
  showHelpOverlay() {
    this.showGestureHint(
      'Tap to click • Long press for right-click • Pinch to zoom • Two-finger pan • Three-finger scroll',
      5000
    );
  }
  
  getViewportInfo() {
    return {
      scale: this.viewport.scale,
      offsetX: this.viewport.offsetX,
      offsetY: this.viewport.offsetY,
      canZoomIn: this.viewport.scale < this.viewport.maxScale,
      canZoomOut: this.viewport.scale > this.viewport.minScale
    };
  }
  
  setViewport(scale, offsetX = 0, offsetY = 0) {
    this.viewport.scale = Math.max(this.viewport.minScale, Math.min(this.viewport.maxScale, scale));
    this.viewport.offsetX = offsetX;
    this.viewport.offsetY = offsetY;
    this.applyViewportTransform();
  }
  
  destroy() {
    // Clean up event listeners and timers
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
    }
    if (this.hideControlsTimer) {
      clearTimeout(this.hideControlsTimer);
    }
    if (this.hideKeyboardTimer) {
      clearTimeout(this.hideKeyboardTimer);
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
    }
    
    // Remove DOM elements
    if (this.controlsContainer) {
      this.controlsContainer.remove();
    }
    
    console.log('[Mobile] Mobile controls destroyed');
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MobileControls;
} else if (typeof window !== 'undefined') {
  window.MobileControls = MobileControls;
}