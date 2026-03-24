console.log('LEGO Builder V4 Loaded');

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { createBrick, BRICK_TYPES, BRICK_COLORS } from './bricks.js';
import { db } from './firebase-config.js';
import { ref, onValue, set, push, remove, onChildAdded, onChildRemoved, get } from 'firebase/database';

class LegoGame {
    constructor() {
        console.log('Initializing LegoGame V4...');
        this.canvas = document.getElementById('game-canvas');
        this.container = document.getElementById('game-canvas-container');
        this.landingScreen = document.getElementById('landing-screen');
        this.roomCodeDisplay = document.getElementById('room-code-display');
        this.playerListEl = document.getElementById('player-list');
        this.uiContainer = document.getElementById('ui-container');
        
        // Player Identity — persistent across sessions
        this.playerId = localStorage.getItem('lego_player_id') || 'p_' + Math.random().toString(36).substring(2, 8);
        localStorage.setItem('lego_player_id', this.playerId);
        this.playerName = localStorage.getItem('lego_player_name') || '';
        this.highlightedPlayerId = null;
        
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xf0faff);
        
        this.currentBrickType = BRICK_TYPES[0];
        this.currentBrickColor = BRICK_COLORS[0].hex;
        this.currentRotation = 0;
        this.bricks = [];
        this.ghostBrick = null;
        this.roomCode = null;
        this.bricksRef = null;
        
        // Interaction states
        this.isDragging = false;
        this.isSelecting = false;
        this.isDraggingCamera = false;
        this.isPlacementValid = false;
        this.selectionStart = new THREE.Vector3();
        
        // New features
        this.selectionState = 'none';
        this.importGhost = null;
        this.importPivot = new THREE.Vector3();

        // --- Sound Effects ---
        this.placeSound = new Audio('freesound_community-lego-piece-pressed-105360.mp3');
        this.breakSound = new Audio('son_duquotidient-bruit-lego-qui-ce-casse-404055.mp3');
        this.placeSound.volume = 0.5;
        this.breakSound.volume = 0.5;

        // Sidebar toggle
        document.getElementById('sidebar-toggle-btn').onclick = () => {
            this.uiContainer.classList.toggle('sidebar-collapsed');
            setTimeout(() => this.onWindowResize(), 310);
        };

        this.setupCamera();
        this.setupLights();
        this.setupRenderer();
        this.setupGrid();
        this.setupInteraction();
        this.setupUI();
        this.setupLobby();
        
        this.animate();
        window.addEventListener('resize', () => this.onWindowResize());
    }

    setupCamera() {
        const aspect = this.container.clientWidth / this.container.clientHeight;
        const d = 10;
        this.camera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 5000);
        this.camera.position.set(20, 20, 20);
        this.camera.lookAt(0, 0, 0);
    }

    setupLights() {
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(10, 20, 10);
        dirLight.castShadow = true;
        this.scene.add(dirLight);

        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
        this.scene.add(hemiLight);
    }

    setupRenderer() {
        this.renderer = new THREE.WebGLRenderer({ 
            canvas: this.canvas, 
            antialias: true,
            preserveDrawingBuffer: true 
        });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
    }

    setupGrid() {
        const floorSize = 4000;
        const floorGeom = new THREE.PlaneGeometry(floorSize, floorSize);
        floorGeom.rotateX(-Math.PI / 2);
        this.floor = new THREE.Mesh(floorGeom, new THREE.MeshBasicMaterial({ visible: false }));
        this.scene.add(this.floor);

        // --- Infinite Grid Shader ---
        const gridVertexShader = `
            varying vec3 vWorldPosition;
            void main() {
                vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                vWorldPosition = worldPosition.xyz;
                gl_Position = projectionMatrix * viewMatrix * worldPosition;
            }
        `;

        const gridFragmentShader = `
            varying vec3 vWorldPosition;
            void main() {
                // Secondary grid lines (every 1 unit, aligned with studs)
                float grid1 = 0.0;
                if (fract(vWorldPosition.x + 0.01) < 0.02 || fract(vWorldPosition.z + 0.01) < 0.02) grid1 = 1.0;
                
                // Primary grid lines (every 10 units)
                float grid10 = 0.0;
                if (fract((vWorldPosition.x + 0.01) / 10.0) < 0.002 || fract((vWorldPosition.z + 0.01) / 10.0) < 0.002) grid10 = 1.0;

                float alpha = mix(0.05, 0.15, grid10);
                if (grid1 <= 0.0 && grid10 <= 0.0) discard;
                
                gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
            }
        `;

        const gridMat = new THREE.ShaderMaterial({
            vertexShader: gridVertexShader,
            fragmentShader: gridFragmentShader,
            transparent: true,
            side: THREE.DoubleSide
        });

        this.grid = new THREE.Mesh(floorGeom, gridMat);
        this.grid.position.y = -0.01; // Slightly below bricks
        this.scene.add(this.grid);

        // Selection Box for Export
        this.selectionBox = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.2, side: THREE.DoubleSide })
        );
        this.selectionBox.visible = false;
        this.scene.add(this.selectionBox);

        const edgeGeom = new THREE.EdgesGeometry(this.selectionBox.geometry);
        this.selectionEdges = new THREE.LineSegments(edgeGeom, new THREE.LineBasicMaterial({ color: 0x00ff00 }));
        this.selectionBox.add(this.selectionEdges);

        // Selection Marker (Cursor for export)
        this.selectionMarker = new THREE.Mesh(
            new THREE.BoxGeometry(1.05, 0.1, 1.05),
            new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.5 })
        );
        this.selectionMarker.visible = false;
        this.scene.add(this.selectionMarker);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.PAN
        };

        this.controls.addEventListener('start', () => {
            this.isDraggingCamera = true;
        });
        this.controls.addEventListener('end', () => {
            this.isDraggingCamera = false;
        });
    }

    setupInteraction() {
        this.mouse = new THREE.Vector2();
        this.raycaster = new THREE.Raycaster();
        this.isDragging = false;
        this.isSelecting = false;
        this.selectionStart = new THREE.Vector3();
        this.mouseDownPos = new THREE.Vector2();
        const CLICK_THRESHOLD = 5;

        this.container.addEventListener('mousedown', (e) => {
            this.mouseDownPos.set(e.clientX, e.clientY);
            this.isDragging = false;
            
            const rect = this.canvas.getBoundingClientRect();
            this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            if (this.selectionState === 'picking-start') {
                this.selectionState = 'selecting';
                this.controls.enabled = false;
                const intersect = this.getIntersect();
                if (intersect) {
                    this.selectionStart.copy(intersect.point);
                    this.selectionBox.visible = true;
                    document.getElementById('floating-export-container').classList.add('hidden');
                }
            } else if (e.shiftKey) {
                this.selectionState = 'selecting';
                this.controls.enabled = false;
                const intersect = this.getIntersect();
                if (intersect) {
                    this.selectionStart.copy(intersect.point);
                    this.selectionBox.visible = true;
                }
            }
        });

        this.container.addEventListener('mousemove', (e) => {
            const dist = Math.sqrt(Math.pow(e.clientX - this.mouseDownPos.x, 2) + Math.pow(e.clientY - this.mouseDownPos.y, 2));
            if (dist > CLICK_THRESHOLD) {
                this.isDragging = true;
            }
            
            const rect = this.canvas.getBoundingClientRect();
            this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            if (this.selectionState === 'selecting') {
                this.updateSelection(e);
            } else {
                this.onMouseMove(e);
            }
        });

        this.container.addEventListener('mouseup', (e) => {
            if (this.selectionState === 'selecting') {
                this.selectionState = 'selection-ready';
                this.controls.enabled = true;
                document.getElementById('floating-export-container').classList.remove('hidden');
            } else if (this.importGhost) {
                this.onImportClick(e);
            } else if (!this.isDragging) {
                if (e.button === 0) {
                    this.onMouseClick(e);
                } else if (e.button === 2) {
                    this.onRightClick(e);
                }
            } else {
                this.controls.enabled = true;
            }
        });

        this.container.addEventListener('contextmenu', (e) => e.preventDefault());

        window.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 'r') {
                if (this.importGhost) {
                    this.importGhost.rotation.y += Math.PI / 2;
                } else {
                    this.currentRotation += Math.PI / 2;
                    this.updateGhostBrick();
                }
            }
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (this.importGhost) {
                    this.cancelImport();
                } else {
                    this.onRightClick(null);
                }
            }
            if (e.key === 'Escape') {
                this.cancelImport();
                this.selectionState = 'none';
                this.selectionBox.visible = false;
            }
        });
    }

    onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this.updateGhostBrick();
    }

    updateGhostBrick() {
        // Toggle visibility based on state
        const inSpecialMode = (this.importGhost !== null || this.selectionState !== 'none');
        
        if (inSpecialMode) {
            if (this.ghostBrick) this.ghostBrick.visible = false;
        } else {
            if (this.ghostBrick) this.ghostBrick.visible = true;
        }

        // --- Normal Ghost Brick Logic ---
        if (!inSpecialMode) {
            this.raycaster.setFromCamera(this.mouse, this.camera);
            const targets = [this.floor, ...this.bricks];
            const intersects = this.raycaster.intersectObjects(targets, true);

            if (intersects.length > 0) {
                const intersect = intersects[0];
                let pos = intersect.point.clone();
                
                pos.x = Math.round(pos.x);
                pos.z = Math.round(pos.z);
                
                if (intersect.object !== this.floor) {
                    let brick = intersect.object;
                    while (brick && !brick.userData.typeId && brick.parent) {
                        brick = brick.parent;
                    }
                    
                    if (brick) {
                        const brickY = brick.position.y;
                        const brickH = brick.userData.height || 1;
                        
                        // If we hit anything at or above the top surface (like studs), stack.
                        // Otherwise (hitting the side), place at the same level.
                        if (intersect.point.y >= brickY + brickH - 0.01) {
                            pos.y = brickY + brickH;
                        } else {
                            pos.y = brickY;
                        }
                    } else {
                        pos.y = 0;
                    }
                    pos.y = Math.round(pos.y * 3) / 3;
                } else {
                    pos.y = 0;
                }

                if (!this.ghostBrick || this.ghostBrick.userData.typeId !== this.currentBrickType.id) {
                    if (this.ghostBrick) this.scene.remove(this.ghostBrick);
                    const colorData = BRICK_COLORS.find(c => c.hex === this.currentBrickColor);
                    this.ghostBrick = createBrick(this.currentBrickType, this.currentBrickColor, colorData?.opacity || 1.0);
                    this.ghostBrick.userData.typeId = this.currentBrickType.id;
                    this.scene.add(this.ghostBrick);
                }

                let offsetX = (this.currentBrickType.w % 2 === 0) ? 0.5 : 0;
                let offsetZ = (this.currentBrickType.d % 2 === 0) ? 0.5 : 0;
                
                const isRotated = Math.abs(Math.sin(this.currentRotation)) > 0.5;
                if (isRotated) {
                    offsetX = (this.currentBrickType.d % 2 === 0) ? 0.5 : 0;
                    offsetZ = (this.currentBrickType.w % 2 === 0) ? 0.5 : 0;
                }

                this.ghostBrick.position.set(pos.x + offsetX, pos.y, pos.z + offsetZ);
                this.ghostBrick.rotation.y = this.currentRotation;

                const status = this.checkPlacement(this.ghostBrick);
                this.isPlacementValid = status.isValid;

                this.ghostBrick.children.forEach(child => {
                    if (child.material) {
                        if (!child.userData.originalMat) child.userData.originalMat = child.material;
                        child.material = child.userData.originalMat.clone();
                        child.material.transparent = true;
                        child.material.opacity = 0.5;
                        child.material.color.set(this.isPlacementValid ? this.currentBrickColor : 0xff0000);
                    }
                });
            }
        }

        // --- Selection Marker Logic ---
        if (this.selectionState !== 'none') {
            this.selectionMarker.visible = true;
            this.raycaster.setFromCamera(this.mouse, this.camera);
            const intersect = this.raycaster.intersectObject(this.floor)[0];
            if (intersect) {
                this.selectionMarker.position.set(
                    Math.round(intersect.point.x),
                    0.05,
                    Math.round(intersect.point.z)
                );
            }
        } else {
            this.selectionMarker.visible = false;
        }

        // --- Import Ghost Logic ---
        if (this.importGhost) {
            this.raycaster.setFromCamera(this.mouse, this.camera);
            const intersect = this.raycaster.intersectObject(this.floor)[0];
            if (intersect) {
                this.importGhost.position.set(
                    Math.round(intersect.point.x),
                    0,
                    Math.round(intersect.point.z)
                );
                this.importGhost.visible = true;
            } else {
                this.importGhost.visible = false;
            }
        }
    }

    checkPlacement(brick) {
        brick.updateMatrixWorld(true);
        const currentBox = new THREE.Box3().setFromObject(brick);
        
        // COLLISION: Rise slightly more (0.22) to clear studs (0.20)
        const collisionBox = currentBox.clone().expandByScalar(-0.05);
        // Only raise collision box if we are NOT on the floor
        if (brick.position.y > 0.05) {
            collisionBox.min.y += 0.22; 
        }

        for (const existingBrick of this.bricks) {
            const existingBox = new THREE.Box3().setFromObject(existingBrick);
            if (collisionBox.intersectsBox(existingBox)) {
                return { isValid: false, reason: 'Collision with existing brick' };
            }
        }

        if (brick.position.y > 0.1) {
            const supportBox = currentBox.clone().expandByScalar(-0.1);
            supportBox.min.y -= 0.15;
            supportBox.max.y = currentBox.min.y + 0.05;

            let hasSupport = false;
            let supportHasStuds = false;

            for (const existingBrick of this.bricks) {
                const existingBox = new THREE.Box3().setFromObject(existingBrick);
                if (supportBox.intersectsBox(existingBox)) {
                    hasSupport = true;
                    if (existingBrick.userData.hasStuds) supportHasStuds = true;
                    break;
                }
            }

            if (!hasSupport) return { isValid: false, reason: 'No support below' };
            if (!supportHasStuds) return { isValid: false, reason: 'Bottom brick has no studs (Tile)' };
        }

        return { isValid: true };
    }

    setupLobby() {
        const joinBtn = document.getElementById('join-room-btn');
        const createBtn = document.getElementById('create-room-btn');
        const roomInput = document.getElementById('room-code-input');
        const nameInput = document.getElementById('player-name-input');
        const step1 = document.getElementById('landing-step-1');
        const step2 = document.getElementById('landing-step-2');
        const startBtn = document.getElementById('start-game-btn');

        // Pre-fill saved name
        if (this.playerName) nameInput.value = this.playerName;

        const getPlayerName = () => {
            const n = nameInput.value.trim();
            return n || `Builder ${this.playerId.substring(2, 7).toUpperCase()}`;
        };

        // JOIN: enter room directly with typed code
        joinBtn.onclick = () => {
            const code = roomInput.value.trim().toUpperCase();
            if (code.length < 1) {
                alert('Please enter a room code to join.');
                return;
            }
            if (code.length !== 6) {
                alert('Room code must be 6 characters.');
                return;
            }
            this.playerName = getPlayerName();
            localStorage.setItem('lego_player_name', this.playerName);
            this.enterRoom(code);
        };

        // CREATE: generate a code then show game mode selection
        createBtn.onclick = () => {
            this.playerName = getPlayerName();
            localStorage.setItem('lego_player_name', this.playerName);
            this._pendingRoomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
            step1.classList.add('hidden');
            step2.classList.remove('hidden');
        };

        // START from mode selection
        startBtn.onclick = () => {
            this.enterRoom(this._pendingRoomCode);
        };
    }

    updatePlayerList(playersData) {
        if (!this.playerListEl) return;
        this.playerListEl.innerHTML = '';
        
        // Always ensure current player is in the list
        const players = playersData ? Object.values(playersData) : [];
        const hasMe = players.some(p => p.id === this.playerId);
        
        if (!hasMe) {
            players.push({
                id: this.playerId,
                name: this.playerName || 'You'
            });
        }
        
        players.forEach(player => {
            const item = document.createElement('div');
            const isMe = player.id === this.playerId;
            const isHighlighted = this.highlightedPlayerId === player.id;
            item.className = `player-item ${isMe ? 'is-me' : ''} ${isHighlighted ? 'highlighted' : ''}`.trim();
            
            const dot = document.createElement('div');
            dot.className = 'player-color-dot';
            dot.style.background = this._playerColor(player.id);
            
            const name = document.createElement('span');
            name.className = 'player-name';
            name.innerText = isMe ? `${player.name} (You)` : player.name;
            
            const eyeBtn = document.createElement('button');
            eyeBtn.className = `eye-btn ${isHighlighted ? 'active' : ''}`;
            eyeBtn.innerHTML = '👁️';
            eyeBtn.title = isHighlighted ? 'Show all bricks' : `Highlight ${player.name}'s bricks`;
            eyeBtn.onclick = () => this.togglePlayerHighlight(player.id);
            
            item.appendChild(dot);
            item.appendChild(name);
            item.appendChild(eyeBtn);
            this.playerListEl.appendChild(item);
        });
    }

    // Deterministic colour per player ID
    _playerColor(playerId) {
        const colors = ['#ff4757','#1cb0f6','#ff9f00','#58cc02','#a855f7','#ff6b81','#00d2ff','#ffa726'];
        let hash = 0;
        for (let i = 0; i < playerId.length; i++) hash = (hash * 31 + playerId.charCodeAt(i)) | 0;
        return colors[Math.abs(hash) % colors.length];
    }

    togglePlayerHighlight(playerId) {
        // Toggle off if already highlighting
        this.highlightedPlayerId = (this.highlightedPlayerId === playerId) ? null : playerId;
        this.applyHighlightState();

        // Update UI to show active state on eye button
        if (db && this.roomCode) {
            get(ref(db, `rooms/${this.roomCode}/players`)).then(snap => {
                this.updatePlayerList(snap.val());
            });
        }
    }

    applyHighlightState() {
        this.bricks.forEach(brick => {
            const isTarget = this.highlightedPlayerId === null ||
                             brick.userData.playerId === this.highlightedPlayerId;
            this._setBrickOpacity(brick, isTarget ? null : 0.07);
        });
    }

    _setBrickOpacity(brick, opacity) {
        brick.traverse(child => {
            if (!child.isMesh) return;
            
            // Store original values once
            if (child.userData.baseOpacity === undefined) {
                child.userData.baseOpacity = child.material.opacity ?? 1.0;
                child.userData.baseTransparent = child.material.transparent;
            }

            // To have independent opacity per brick, we MUST clone the material 
            // the first time we modify it, as Three.js materials are shared by default.
            if (!child.userData.isCloned) {
                child.material = child.material.clone();
                child.userData.isCloned = true;
            }

            const target = (opacity === null) ? child.userData.baseOpacity : opacity;
            child.material.transparent = (opacity !== null) || child.userData.baseTransparent;
            child.material.opacity = target;
            child.material.needsUpdate = true;
        });
    }

    enterRoom(code) {
        console.log('Entering Room:', code);
        this.roomCode = code;
        if (this.roomCodeDisplay) this.roomCodeDisplay.innerText = code;
        this.landingScreen.classList.add('hidden');
        document.getElementById('ui-container').classList.remove('hidden');
        
        // Register Player
        if (db) {
            const playerRef = ref(db, `rooms/${code}/players/${this.playerId}`);
            set(playerRef, {
                id: this.playerId,
                name: this.playerName || `Builder ${this.playerId.substring(2, 7).toUpperCase()}`,
                lastActive: Date.now()
            });

            // Listen for player changes
            const playersRef = ref(db, `rooms/${code}/players`);
            onValue(playersRef, (snapshot) => {
                this.updatePlayerList(snapshot.val());
            });
        }
        
        // Fix camera aspect ratio and renderer size after showing
        setTimeout(() => this.onWindowResize(), 10);
        
        // Connect to Firebase
        if (db) {
            this.bricksRef = ref(db, `rooms/${code}/bricks`);
            
            // Listen for additions
            onChildAdded(this.bricksRef, (snapshot) => {
                const data = snapshot.val();
                if (this.bricks.some(b => b.userData.firebaseKey === snapshot.key)) return;
                
                const type = BRICK_TYPES.find(t => t.id === data.typeId);
                const brick = createBrick(type, data.color, data.opacity || 1.0);
                brick.position.set(data.x, data.y, data.z);
                brick.rotation.y = data.ry;
                brick.userData.firebaseKey = snapshot.key;
                brick.userData.playerId = data.playerId;
                brick.castShadow = true;
                brick.receiveShadow = true;
                
                this.scene.add(brick);
                this.bricks.push(brick);

                // Apply current highlight state to the newly added brick
                if (this.highlightedPlayerId !== null) {
                    const isTarget = brick.userData.playerId === this.highlightedPlayerId;
                    this._setBrickOpacity(brick, isTarget ? null : 0.07);
                }
            });

            // Pre-place baseplates if room is new
            get(this.bricksRef).then(snapshot => {
                if (!snapshot.exists()) {
                    console.log('New room detected. Placing initial baseplates...');
                    const bpType = BRICK_TYPES.find(t => t.id === '32x32 BP');
                    const greenColor = 0x388e3c; // Green
                    
                    // Place 4 baseplates in 2x2 grid
                    const offsets = [-16, 16];
                    offsets.forEach(ox => {
                        offsets.forEach(oz => {
                            // Even-sized bricks (32) need 0.5 offset to align with grid edges
                            push(this.bricksRef, {
                                typeId: bpType.id,
                                color: greenColor,
                                opacity: 1.0,
                                x: ox + 0.5,
                                y: 0,
                                z: oz + 0.5,
                                ry: 0,
                                playerId: 'system'
                            });
                        });
                    });
                }
            });

            // Listen for removals
            onChildRemoved(this.bricksRef, (snapshot) => {
                const brick = this.bricks.find(b => b.userData.firebaseKey === snapshot.key);
                if (brick) {
                    this.scene.remove(brick);
                    this.bricks = this.bricks.filter(b => b !== brick);
                }
            });
        } else {
            console.warn('Firebase not connected. Project is in Local/Offline mode.');
        }
    }

    onMouseClick(e) {
        if (this.ghostBrick && this.isPlacementValid) {
            // Play sound locally for immediate feedback
            this.placeSound.currentTime = 0;
            this.placeSound.play().catch(e => console.warn('Sound play blocked:', e));

            const brickData = {
                typeId: this.currentBrickType.id,
                color: this.currentBrickColor,
                opacity: BRICK_COLORS.find(c => c.hex === this.currentBrickColor)?.opacity || 1.0,
                x: this.ghostBrick.position.x,
                y: this.ghostBrick.position.y,
                z: this.ghostBrick.position.z,
                ry: this.ghostBrick.rotation.y,
                playerId: this.playerId
            };
            
            if (this.bricksRef) {
                push(this.bricksRef, brickData);
            } else {
                // Fallback for single player / testing
                const brick = createBrick(this.currentBrickType, this.currentBrickColor, brickData.opacity);
                brick.position.copy(this.ghostBrick.position);
                brick.rotation.copy(this.ghostBrick.rotation);
                brick.castShadow = true;
                brick.receiveShadow = true;
                this.scene.add(brick);
                this.bricks.push(brick);
            }
        }
    }

    onRightClick(e) {
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.bricks, true);
        if (intersects.length > 0) {
            // Play sound locally for immediate feedback
            this.breakSound.currentTime = 0;
            this.breakSound.play().catch(e => console.warn('Sound play blocked:', e));

            let obj = intersects[0].object;
            while (obj.parent && obj.parent.type !== 'Scene' && obj.parent !== null) {
                obj = obj.parent;
            }
            
            if (db && this.bricksRef && obj.userData.firebaseKey) {
                remove(ref(db, `rooms/${this.roomCode}/bricks/${obj.userData.firebaseKey}`));
            } else {
                this.removeBrick(obj);
            }
        }
    }

    removeBrick(brick) {
        this.scene.remove(brick);
        this.bricks = this.bricks.filter(b => b !== brick);
    }

    setupUI() {
        const brickSelector = document.getElementById('brick-selector');
        const categories = [...new Set(BRICK_TYPES.map(t => t.cat))];
        brickSelector.innerHTML = '';
        
        categories.forEach(cat => {
            const title = document.createElement('div');
            title.className = 'cat-title';
            title.innerText = cat;
            brickSelector.appendChild(title);
            
            const grid = document.createElement('div');
            grid.className = 'brick-grid';
            brickSelector.appendChild(grid);

            BRICK_TYPES.filter(t => t.cat === cat).forEach(type => {
                const item = document.createElement('div');
                item.className = 'brick-item';
                item.innerText = type.id;
                item.onclick = () => {
                    this.currentBrickType = type;
                    document.querySelectorAll('.brick-item').forEach(el => el.classList.remove('active'));
                    item.classList.add('active');
                };
                if (type.id === this.currentBrickType.id) item.classList.add('active');
                grid.appendChild(item);
            });
        });

        const colorSelector = document.getElementById('color-selector');
        colorSelector.innerHTML = '';
        const colorTitle = document.createElement('div');
        colorTitle.className = 'cat-title';
        colorTitle.innerText = 'Colors';
        colorSelector.appendChild(colorTitle);

        const colorGrid = document.createElement('div');
        colorGrid.className = 'color-grid';
        colorSelector.appendChild(colorGrid);

        BRICK_COLORS.forEach(color => {
            const item = document.createElement('div');
            item.className = 'color-item';
            const swatch = document.createElement('div');
            swatch.className = 'color-swatch';
            swatch.style.backgroundColor = `#${color.hex.toString(16).padStart(6, '0')}`;
            if (color.opacity < 1) swatch.style.opacity = color.opacity;
            item.appendChild(swatch);
            item.onclick = () => {
                this.currentBrickColor = color.hex;
                document.querySelectorAll('.color-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
            };
            if (color.hex === this.currentBrickColor) item.classList.add('active');
            colorGrid.appendChild(item);
        });

        document.getElementById('camera-btn').onclick = () => this.takeScreenshot();
        document.getElementById('export-btn').onclick = () => this.exportArea();
        document.getElementById('import-btn').onclick = () => this.triggerImport();
        document.getElementById('undo-btn').onclick = () => {
            const b = this.bricks.pop();
            if (b) this.scene.remove(b);
        };
        document.getElementById('clear-btn').onclick = () => {
            this.bricks.forEach(b => this.scene.remove(b));
            this.bricks = [];
            this.selectionBox.visible = false;
        };

        // Floating export buttons
        document.getElementById('floating-export-btn').onclick = () => this.performExport();
        document.getElementById('cancel-selection-btn').onclick = () => {
            this.selectionBox.visible = false;
            this.selectionState = 'none';
            document.getElementById('floating-export-container').classList.add('hidden');
            if (this.ghostBrick) this.ghostBrick.visible = true;
        };
    }

    getIntersect() {
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects([this.floor], true);
        return intersects[0] || null;
    }

    onImportClick(e) {
        if (!this.importGhost) return;
        
        // Place all bricks from the ghost building
        this.importGhost.children.slice().forEach(child => {
            const worldPos = new THREE.Vector3();
            child.getWorldPosition(worldPos);
            const worldQuat = new THREE.Quaternion();
            child.getWorldQuaternion(worldQuat);
            const worldEuler = new THREE.Euler().setFromQuaternion(worldQuat);

            const brickData = {
                typeId: child.userData.typeId,
                color: child.userData.color,
                x: Math.round(worldPos.x),
                y: worldPos.y, // Keep precise Y for plates/bricks
                z: Math.round(worldPos.z),
                ry: worldEuler.y,
                playerId: this.playerId
            };

            if (this.bricksRef) {
                push(this.bricksRef, brickData);
            } else {
                const type = BRICK_TYPES.find(t => t.id === brickData.typeId);
                const brick = createBrick(type, brickData.color, 1.0);
                brick.position.set(brickData.x, brickData.y, brickData.z);
                brick.rotation.y = brickData.ry;
                brick.userData.typeId = brickData.typeId;
                brick.userData.color = brickData.color;
                this.scene.add(brick);
                this.bricks.push(brick);
            }
        });

        this.cancelImport();
    }

    cancelImport() {
        if (this.importGhost) {
            this.scene.remove(this.importGhost);
            this.importGhost = null;
        }
        this.controls.enabled = true;
    }

    updateSelection(e) {
        const intersect = this.getIntersect();
        if (intersect && this.selectionState === 'selecting') {
            const end = intersect.point;
            const start = this.selectionStart;
            
            const minX = Math.min(start.x, end.x);
            const maxX = Math.max(start.x, end.x);
            const minZ = Math.min(start.z, end.z);
            const maxZ = Math.max(start.z, end.z);
            
            const height = 50.0;
            
            this.selectionBox.position.set((minX + maxX) / 2, height / 2, (minZ + maxZ) / 2);
            this.selectionBox.scale.set(Math.abs(maxX - minX) || 0.1, height, Math.abs(maxZ - minZ) || 0.1);
            this.selectionBox.visible = true;
        }
    }

    exportArea() {
        if (this.selectionState === 'none') {
            this.selectionState = 'picking-start';
            if (this.ghostBrick) this.ghostBrick.visible = false;
            alert('Click and Drag on the floor to select your export area');
        } else {
            this.selectionState = 'none';
            this.selectionBox.visible = false;
            if (this.ghostBrick) this.ghostBrick.visible = true;
            document.getElementById('floating-export-container').classList.add('hidden');
        }
    }

    performExport() {
        const box = new THREE.Box3().setFromObject(this.selectionBox);
        const exportedBricks = this.bricks.filter(brick => {
            const brickBox = new THREE.Box3().setFromObject(brick);
            return box.intersectsBox(brickBox);
        }).map(brick => ({
            typeId: brick.userData.typeId,
            color: brick.userData.color,
            x: brick.position.x,
            y: brick.position.y,
            z: brick.position.z,
            ry: brick.rotation.y
        }));

        if (exportedBricks.length === 0) {
            alert('No bricks found in selection!');
            return;
        }

        const data = JSON.stringify({ version: 1, bricks: exportedBricks }, null, 2);
        const blobObj = new Blob([data], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blobObj);
        link.download = `lego_model_${Date.now()}.json`;
        link.click();
        
        this.selectionBox.visible = false;
        this.selectionState = 'none';
        if (this.ghostBrick) this.ghostBrick.visible = true;
        document.getElementById('floating-export-container').classList.add('hidden');
    }

    triggerImport() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    if (data && Array.isArray(data.bricks)) {
                        this.createImportGhost(data.bricks);
                    } else {
                        throw new Error('Invalid format');
                    }
                } catch (err) {
                    alert('Invalid model file');
                }
                document.body.removeChild(input);
            };
            reader.readAsText(file);
        };
        document.body.appendChild(input);
        input.click();
    }

    createImportGhost(brickList) {
        if (this.importGhost) this.cancelImport();
        
        this.importGhost = new THREE.Group();
        
        // Find center of the model for better rotation
        const box = new THREE.Box3();
        brickList.forEach(data => {
            const type = BRICK_TYPES.find(t => t.id === data.typeId);
            if (!type) {
                console.warn(`Skipping unknown brick type: ${data.typeId}`);
                return;
            }
            const brick = createBrick(type, data.color, 0.5);
            brick.position.set(data.x, data.y, data.z);
            brick.rotation.y = data.ry;
            brick.userData.typeId = data.typeId;
            brick.userData.color = data.color;
            this.importGhost.add(brick);
            box.expandByObject(brick);
        });

        const center = new THREE.Vector3();
        box.getCenter(center);
        center.y = 0; // Keep on floor

        // Offset all bricks so the group's (0,0,0) is the center point on floor
        this.importGhost.children.forEach(child => {
            child.position.sub(center);
        });

        this.scene.add(this.importGhost);
        alert('Model loaded as ghost. Use "R" to rotate. Click on ground to place.');
    }

    takeScreenshot() {
        console.log('Capturing screenshot...');
        // Hide grid and ghost block
        if (this.grid) this.grid.visible = false;
        if (this.ghostBrick) this.ghostBrick.visible = false;
        
        // Render one frame for the buffer
        this.renderer.render(this.scene, this.camera);
        
        try {
            this.canvas.toBlob((blob) => {
                if (!blob) {
                    console.error('Blob generation failed');
                    return;
                }
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.download = `lego_build_${Date.now()}.png`;
                link.href = url;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 100);
            }, 'image/png');
        } catch (e) {
            console.error('Screenshot failed:', e);
        }
        
        // Restore visibility
        if (this.grid) this.grid.visible = true;
        if (this.ghostBrick) this.ghostBrick.visible = true;
    }

    onWindowResize() {
        const aspect = this.container.clientWidth / this.container.clientHeight;
        const d = 10;
        this.camera.left = -d * aspect;
        this.camera.right = d * aspect;
        this.camera.top = d;
        this.camera.bottom = -d;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this.controls.update();

        // Make grid follow camera for "infinite" effect
        if (this.grid) {
            this.grid.position.x = this.camera.position.x;
            this.grid.position.z = this.camera.position.z;
        }

        this.renderer.render(this.scene, this.camera);
    }
}

new LegoGame();
