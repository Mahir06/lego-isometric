console.log('LEGO Builder V4 Loaded');

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { createBrick, BRICK_TYPES, BRICK_COLORS } from './bricks.js';
import { db } from './firebase-config.js';
import { ref, onValue, set, push, remove, onChildAdded, onChildRemoved, get, onDisconnect, runTransaction } from 'firebase/database';

class LegoGame {
    constructor() {
        console.log('Initializing LegoGame V4...');
        this.canvas = document.getElementById('game-canvas');
        this.container = document.getElementById('game-canvas-container');
        this.landingScreen = document.getElementById('landing-screen');
        this.roomCodeDisplay = document.getElementById('room-code-display');
        this.playerListEl = document.getElementById('player-list');
        this.uiContainer = document.getElementById('ui-container');
        
        // Player Identity — unique per tab session to allow multi-tab testing
        this.playerId = sessionStorage.getItem('lego_player_id') || 'p_' + Math.random().toString(36).substring(2, 8);
        sessionStorage.setItem('lego_player_id', this.playerId);
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
        this.arrowOffset = new THREE.Vector3(0, 0, 0); 
        this.rodRotationIndex = 0; // For Rod axial rotation

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
        
        // OVERCOOKED MODE SPECIFIC
        this.gameMode = 'free-build'; 
        this.overcookedRoomId = null; 
        this.isReady = false;
        this.currentRole = null;
        this.gameState = 'WAITING';
        this.timerInterval = null;
        this.overcookedLobbyEl = document.getElementById('landing-overcooked-lobby');
        this.overcookedRoomEl = document.getElementById('landing-overcooked-room');
        this.roomGridEl = document.getElementById('overcooked-room-grid');
        this.readyListEl = document.getElementById('overcooked-ready-list');
        this.hudEl = document.getElementById('overcooked-hud');
        this.modalEl = document.getElementById('modal-overlay');
        
        // REFERENCE VIEW (Secondary Scene)
        this.referencePanel = document.getElementById('reference-panel');
        this.refContainer = document.getElementById('reference-canvas-container');
        this.timerExpired = false;
        
        document.getElementById('close-reference-btn').onclick = () => this.toggleReferenceView(false);
        this.initReferenceView();
        
        this.animate();
        window.addEventListener('resize', () => this.onWindowResize());
    }

    setupCamera() {
        const aspect = this.container.clientWidth / this.container.clientHeight;
        const d = 10;
        this.camera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 1000);
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
        const floorGeom = new THREE.PlaneGeometry(100, 100);
        floorGeom.rotateX(-Math.PI / 2);
        this.floor = new THREE.Mesh(floorGeom, new THREE.MeshBasicMaterial({ visible: false }));
        this.scene.add(this.floor);

        // Grid helper for visual reference
        this.grid = new THREE.GridHelper(40, 40, 0x000000, 0x000000);
        this.grid.material.opacity = 0.1;
        this.grid.material.transparent = true;
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
            if (this.gameMode === 'overcooked' && this.timerExpired) return;
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
            if (this.gameMode === 'overcooked' && this.timerExpired) return;
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
            if (this.gameMode === 'overcooked' && this.timerExpired) return;
            if (e.key.toLowerCase() === 'r') {
                if (this.importGhost) {
                    this.importGhost.rotation.y += Math.PI / 2;
                } else if (this.currentBrickType && this.currentBrickType.shape === 'rod') {
                    // Cycle rod orientation
                    this.rodRotationIndex = (this.rodRotationIndex + 1) % 4;
                    this.updateGhostBrick();
                } else {
                    this.currentRotation += Math.PI / 2;
                    this.updateGhostBrick();
                }
            }
            if (e.key.toLowerCase() === 'r' && this.gameMode === 'overcooked' && this.gameState === 'ROUND_2_BUILD') {
                if (!this.canPerform('ROTATOR')) {
                    e.stopImmediatePropagation();
                    return;
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

            // Arrow key adjustments (1 stud - camera relative)
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();

                // Get camera directions projected on XZ floor
                const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
                forward.y = 0;
                forward.normalize();

                const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
                right.y = 0;
                right.normalize();

                // Helper to find the cardinal grid axis closest to a direction
                const getClosestAxis = (vec) => {
                    const axes = [
                        new THREE.Vector3(1, 0, 0),
                        new THREE.Vector3(-1, 0, 0),
                        new THREE.Vector3(0, 0, 1),
                        new THREE.Vector3(0, 0, -1)
                    ];
                    let maxDot = -Infinity;
                    let closest = axes[0];
                    axes.forEach(a => {
                        const dot = vec.dot(a);
                        if (dot > maxDot) {
                            maxDot = dot;
                            closest = a;
                        }
                    });
                    return closest;
                };

                const moveForward = getClosestAxis(forward);
                const moveRight = getClosestAxis(right);

                if (e.key === 'ArrowUp') this.arrowOffset.add(moveForward);
                if (e.key === 'ArrowDown') this.arrowOffset.sub(moveForward);
                if (e.key === 'ArrowLeft') this.arrowOffset.sub(moveRight);
                if (e.key === 'ArrowRight') this.arrowOffset.add(moveRight);
                
                this.updateGhostBrick();
            }
        });
    }

    onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        
        // Reset manual arrow-key offset when moving mouse again
        if (this.arrowOffset.x !== 0 || this.arrowOffset.z !== 0) {
            this.arrowOffset.set(0, 0, 0);
        }
        
        this.updateGhostBrick();
    }

    updateGhostBrick() {
        // Toggle visibility based on state
        const inSpecialMode = (this.importGhost !== null || this.selectionState !== 'none');
        
        if (inSpecialMode) {
            if (this.ghostBrick) this.ghostBrick.visible = false;
        } else {
            // Default to invisible until we find a target
            if (this.ghostBrick) this.ghostBrick.visible = false;
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

            const updateGhostVisuals = () => {
                if (this.ghostBrick) {
                    this.ghostBrick.traverse(child => {
                        if (child.isMesh) {
                            if (!child.userData.originalMat) child.userData.originalMat = child.material;
                            if (!child.userData.ghostMat) {
                                child.userData.ghostMat = child.userData.originalMat.clone();
                                child.userData.ghostMat.transparent = true;
                                child.userData.ghostMat.opacity = 0.5;
                            }
                            child.material = child.userData.ghostMat;
                            child.material.color.set(this.isPlacementValid ? this.currentBrickColor : 0xff0000);
                            child.material.needsUpdate = true;
                        }
                    });
                }
            };

            // --- ROD SPECIAL SNAPPING ---
            if (this.currentBrickType.shape === 'rod') {
                let bestHole = null;
                let minDist = 1.0;
                
                this.bricks.forEach(b => {
                    b.traverse(child => {
                        if (child.userData.isHole) {
                            const holeWPos = new THREE.Vector3();
                            child.getWorldPosition(holeWPos);
                            const d = pos.distanceTo(holeWPos);
                            if (d < minDist) {
                                minDist = d;
                                bestHole = child;
                            }
                        }
                    });
                });

                if (bestHole) {
                    const holeWPos = new THREE.Vector3();
                    bestHole.getWorldPosition(holeWPos);
                    pos.copy(holeWPos);
                    
                    // Initialize ghost if not already created
                    if (!this.ghostBrick || this.ghostBrick.userData.typeId !== this.currentBrickType.id) {
                        if (this.ghostBrick) this.scene.remove(this.ghostBrick);
                        this.ghostBrick = createBrick(this.currentBrickType, this.currentBrickColor);
                        this.ghostBrick.userData.typeId = this.currentBrickType.id;
                        this.scene.add(this.ghostBrick);
                    }
                    
                    this.ghostBrick.position.copy(pos);
                    // Technic holes are along Z axis. Rod (cylinder Y) needs X rotation.
                    this.ghostBrick.rotation.set(Math.PI / 2, 0, 0); 
                    // Manual rotation around rod's own axis
                    this.ghostBrick.rotateY(this.rodRotationIndex * Math.PI / 2);
                    
                    this.isPlacementValid = true;
                    if (this.selectionMarker) this.selectionMarker.visible = false;
                    updateGhostVisuals();
                    return; 
                } else {
                    // No hole found, rod stays at cursor but invalid
                    this.isPlacementValid = false;
                }
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

                this.ghostBrick.position.set(
                    pos.x + offsetX + this.arrowOffset.x, 
                    pos.y, 
                    pos.z + offsetZ + this.arrowOffset.z
                );
                this.ghostBrick.rotation.y = this.currentRotation;

                const status = this.checkPlacement(this.ghostBrick);
                this.isPlacementValid = status.isValid;
                
                // Show ghost if we have a valid target
                if (this.ghostBrick) this.ghostBrick.visible = true;
            } else {
                // No valid target (off grid)
                this.isPlacementValid = false;
                if (this.ghostBrick) this.ghostBrick.visible = false;
            }

            updateGhostVisuals();
        }

        // --- Selection Marker Logic ---
        if (this.selectionState !== 'none') {
            this.selectionMarker.visible = true;
            this.raycaster.setFromCamera(this.mouse, this.camera);
            const intersect = this.raycaster.intersectObject(this.floor)[0];
            if (intersect) {
                this.selectionMarker.position.set(
                    Math.round(intersect.point.x) + this.arrowOffset.x,
                    0.05,
                    Math.round(intersect.point.z) + this.arrowOffset.z
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
                    Math.round(intersect.point.x) + this.arrowOffset.x,
                    0,
                    Math.round(intersect.point.z) + this.arrowOffset.z
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
        
        // COLLISION: Slightly smaller box to ignore standard adjacent contact
        const collisionBox = currentBox.clone().expandByScalar(-0.02);
        
        // When checking collisions, we only care about the MAIN BODIES, not the studs.
        // This allows bricks to sit on top of studs.
        for (const other of this.bricks) {
            if (other === brick) continue;
            
            // Get the first child of the brick, which is the body mesh
            const otherBody = other.children[0];
            if (otherBody) {
                const otherBox = new THREE.Box3().setFromObject(otherBody);
                if (collisionBox.intersectsBox(otherBox)) {
                    return { isValid: false, reason: 'Collision' };
                }
            }
        }

        // CONNECTIVITY: Must be on floor or connected to a stud
        const type = BRICK_TYPES.find(t => t.id === brick.userData.typeId);
        if (brick.position.y < 0.1 && type && type.shape !== 'rod') return { isValid: true };

        let hasConnection = false;
        const ghostBox = new THREE.Box3().setFromObject(brick);
        
        // ROD CONNECTIVITY: Only fits in holes
        if (type && type.shape === 'rod') {
            for (const other of this.bricks) {
                if (other === brick) continue;
                other.traverse(child => {
                    if (child.userData.isHole) {
                        const holeBox = new THREE.Box3().setFromObject(child);
                        // Expand slightly to catch intersection
                        if (ghostBox.intersectsBox(holeBox.expandByScalar(0.1))) {
                            hasConnection = true;
                        }
                    }
                });
                if (hasConnection) break;
            }
            if (!hasConnection) return { isValid: false, reason: 'Rods only fit in holes' };
            return { isValid: true };
        }

        // --- Standard Connectivity (Studs) ---
        for (const other of this.bricks) {
            if (other === brick) continue;
            
            other.traverse(child => {
                if (child.userData && child.userData.isStud) {
                    const studBox = new THREE.Box3().setFromObject(child);
                    // Expand slightly to ensure overlapping detection
                    if (ghostBox.intersectsBox(studBox)) {
                        hasConnection = true;
                    }
                }
            });
            if (hasConnection) break;
        }

        if (!hasConnection) return { isValid: false, reason: 'No connection' };
        return { isValid: true };
    }

    // ─── Screen navigation helper ────────────────────────────────────────────
    // Screens: 'step1' | 'step2' | 'overcooked-lobby' | 'overcooked-room'
    showScreen(name) {
        const step1       = document.getElementById('landing-step-1');
        const step2       = document.getElementById('landing-step-2');
        const lobbyEl     = this.overcookedLobbyEl;
        const roomEl      = this.overcookedRoomEl;
        const backBtn     = document.getElementById('global-back-btn');

        // Hide all
        [step1, step2, lobbyEl, roomEl].forEach(el => el && el.classList.add('hidden'));

        // Show requested
        const map = { 'step1': step1, 'step2': step2, 'overcooked-lobby': lobbyEl, 'overcooked-room': roomEl };
        if (map[name]) map[name].classList.remove('hidden');

        // Show back button on every screen except step1
        if (backBtn) backBtn.classList.toggle('hidden', name === 'step1');

        this._currentScreen = name;
    }

    setupLobby() {
        const joinBtn     = document.getElementById('join-room-btn');
        const createBtn   = document.getElementById('create-room-btn');
        const roomInput   = document.getElementById('room-code-input');
        const nameInput   = document.getElementById('player-name-input');
        const startBtn    = document.getElementById('start-game-btn');
        const modeOvercooked  = document.getElementById('mode-overcooked');
        const modeFreeBuild   = document.getElementById('mode-free-build');
        const backBtn     = document.getElementById('global-back-btn');
        const exitWorldBtn = document.getElementById('exit-world-btn');

        // ── Global Back button ───────────────────────────────────────────────
        backBtn.onclick = () => {
            // Explicitly remove from room if going back from a specific room
            if (this._currentScreen === 'overcooked-room' && this.overcookedRoomId) {
                if (db) remove(ref(db, `overcooked/rooms/${this.overcookedRoomId}/players/${this.playerId}`));
            }

            switch (this._currentScreen) {
                case 'step2':           this.showScreen('step1'); break;
                case 'overcooked-lobby':
                    // If creator — go back to mode select; if joiner — go to step1
                    if (this._pendingRoomCode && this._isWorldCreator) {
                        this.showScreen('step2');
                    } else {
                        this.showScreen('step1');
                    }
                    break;
                case 'overcooked-room': this.showScreen('overcooked-lobby'); break;
                default:                this.showScreen('step1'); break;
            }
        };

        // ── Exit World button (in-game toolbar) ──────────────────────────────
        if (exitWorldBtn) {
            exitWorldBtn.onclick = () => {
                if (confirm('Exit this world and return to the main screen?')) {
                    // Explicitly remove from overcooked room if in one
                    if (this.overcookedRoomId && db) {
                        remove(ref(db, `overcooked/rooms/${this.overcookedRoomId}/players/${this.playerId}`));
                    }
                    // Reload for a clean state
                    window.location.reload();
                }
            };
        }

        // ── Mode Selection ───────────────────────────────────────────────────
        modeFreeBuild.onclick = () => {
            this.gameMode = 'free-build';
            modeFreeBuild.classList.add('active');
            modeOvercooked.classList.remove('active');
        };

        modeOvercooked.onclick = () => {
            this.gameMode = 'overcooked';
            modeOvercooked.classList.add('active');
            modeFreeBuild.classList.remove('active');
        };

        // Pre-fill saved name
        if (this.playerName) nameInput.value = this.playerName;

        const getPlayerName = () => {
            const n = nameInput.value.trim();
            return n || `Builder ${this.playerId.substring(2, 7).toUpperCase()}`;
        };

        // ── JOIN WORLD ───────────────────────────────────────────────────────
        joinBtn.onclick = async () => {
            const code = roomInput.value.trim().toUpperCase();
            if (code.length < 1) { alert('Please enter a world code to join.'); return; }
            if (code.length !== 6) { alert('World code must be 6 characters.'); return; }
            this.playerName = getPlayerName();
            localStorage.setItem('lego_player_name', this.playerName);
            this._pendingRoomCode = code;
            this._isWorldCreator = false;

            // Check game mode of this world
            if (db) {
                try {
                    const metaSnap = await get(ref(db, `rooms/${code}/meta`));
                    const meta = metaSnap.val();
                    if (meta && meta.gameMode === 'overcooked') {
                        this.gameMode = 'overcooked';
                        const lobbyCodeEl = document.getElementById('overcooked-lobby-code');
                        if (lobbyCodeEl) lobbyCodeEl.querySelector('span').innerText = code;
                        this.showScreen('overcooked-lobby');
                        this.setupOvercookedLobby();
                        return;
                    }
                } catch (e) {
                    console.warn('Could not read world meta:', e);
                }
            }

            // Default: free build world
            this.enterRoom(code);
        };

        // ── CREATE WORLD (step 1 → step 2) ──────────────────────────────────
        createBtn.onclick = () => {
            console.log('Create World clicked');
            this.playerName = getPlayerName();
            localStorage.setItem('lego_player_name', this.playerName);
            this._pendingRoomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
            this._isWorldCreator = true;
            this.showScreen('step2');
        };

        // ── CREATE WORLD (step 2 → game/lobby) ──────────────────────────────
        startBtn.onclick = () => {
            try {
                const code = this._pendingRoomCode;
                if (this.gameMode === 'overcooked') {
                    if (db && code) {
                        set(ref(db, `rooms/${code}/meta`), { gameMode: 'overcooked', createdAt: Date.now() })
                            .catch(e => console.warn('Could not write world meta:', e));
                    }
                    const lobbyCodeEl = document.getElementById('overcooked-lobby-code');
                    if (lobbyCodeEl) lobbyCodeEl.querySelector('span').innerText = code || '-';
                    this.showScreen('overcooked-lobby');
                    this.setupOvercookedLobby();
                } else {
                    if (db && code) {
                        set(ref(db, `rooms/${code}/meta`), { gameMode: 'free-build', createdAt: Date.now() })
                            .catch(e => console.warn('Could not write world meta:', e));
                    }
                    this.enterRoom(code);
                }
            } catch (e) {
                console.error('Error creating world:', e);
                alert('Failed to create world: ' + e.message);
            }
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
                
                // RECONCILIATION: Check if we have an optimistic brick at this spot
                const optimisticBrick = this.bricks.find(b => 
                    b.userData.isOptimistic &&
                    Math.abs(b.position.x - data.x) < 0.01 && 
                    Math.abs(b.position.y - data.y) < 0.01 && 
                    Math.abs(b.position.z - data.z) < 0.01 &&
                    b.userData.typeId === data.typeId
                );

                if (optimisticBrick) {
                    optimisticBrick.userData.firebaseKey = snapshot.key;
                    delete optimisticBrick.userData.isOptimistic;
                    return;
                }

                if (this.bricks.some(b => b.userData.firebaseKey === snapshot.key)) {
                    return;
                }
                
                const type = BRICK_TYPES.find(t => t.id === data.typeId);
                if (!type) {
                    console.error('Unknown brick type from Firebase:', data.typeId);
                    return;
                }
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
        if (this.gameMode === 'overcooked' && this.gameState === 'ROUND_2_BUILD') {
            if (!this.canPerform('BUILDER')) return;
        }

        if (this.ghostBrick && this.isPlacementValid) {
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
            
            const exists = this.bricks.some(b => 
                b.position.x === brickData.x && 
                b.position.y === brickData.y && 
                b.position.z === brickData.z &&
                b.userData.typeId === brickData.typeId
            );

            if (!exists) {
                const brick = createBrick(this.currentBrickType, this.currentBrickColor, brickData.opacity);
                brick.position.set(brickData.x, brickData.y, brickData.z);
                brick.rotation.y = brickData.ry;
                brick.userData.typeId = brickData.typeId;
                brick.userData.playerId = brickData.playerId;
                brick.userData.isOptimistic = true; 
                brick.castShadow = true;
                brick.receiveShadow = true;
                
                this.scene.add(brick);
                this.bricks.push(brick);
            }

            if (this.bricksRef) {
                push(this.bricksRef, brickData);
            }
        }
    }

    onRightClick(e) {
        if (this.gameMode === 'overcooked' && this.gameState === 'ROUND_2_BUILD') {
            if (!this.canPerform('REMOVER')) return;
        }

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.bricks, true);
        if (intersects.length > 0) {
            let obj = intersects[0].object;
            while (obj.parent && obj.parent.type !== 'Scene' && obj.parent !== null) {
                obj = obj.parent;
            }
            
            if (db && this.bricksRef && obj.userData.firebaseKey) {
                remove(ref(db, `rooms/${this.roomCode}/bricks/${obj.userData.firebaseKey}`));
            }
            // Always ensure local removal as well, especially if offline or sync fails
            this.removeBrick(obj);
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
                    if (this.gameMode === 'overcooked' && this.timerExpired) return;
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
                if (this.gameMode === 'overcooked' && this.gameState === 'ROUND_2_BUILD') {
                    if (!this.canPerform('COLOR_PICKER')) return;
                }
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
        document.getElementById('undo-btn').onclick = (e) => {
            if (this.gameMode === 'overcooked' && this.timerExpired) return;
            e.stopPropagation();
            const brick = this.bricks[this.bricks.length - 1];
            if (brick) {
                if (this.bricksRef && brick.userData.firebaseKey) {
                    remove(ref(db, `rooms/${this.roomCode}/bricks/${brick.userData.firebaseKey}`));
                } else {
                    this.removeBrick(brick);
                }
            }
        };
        document.getElementById('clear-btn').onclick = (e) => {
            if (this.gameMode === 'overcooked' && this.timerExpired) return;
            e.stopPropagation();
            if (confirm('Are you sure you want to clear EVERYTHING?')) {
                if (this.bricksRef) {
                    remove(this.bricksRef);
                } else {
                    this.bricks.forEach(b => this.scene.remove(b));
                    this.bricks = [];
                }
                this.selectionBox.visible = false;
            }
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
        if (this.gameMode === 'overcooked' && this.gameState === 'ROUND_2_BUILD') {
            if (!this.canPerform('SELECTOR')) return;
        }

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
            const brick = createBrick(type, data.color, 0.4); // 0.4 opacity for ghost blocks
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
        if (this.controls) this.controls.update();
        this.renderer.render(this.scene, this.camera);
        
        // Render secondary reference scene if visible
        if (this.refRenderer && !this.referencePanel.classList.contains('hidden')) {
            this.refRenderer.render(this.refScene, this.refCamera);
        }
    }

    // ─── REFERENCE VIEW METHODS ──────────────────────────────────────────────
    initReferenceView() {
        this.refScene = new THREE.Scene();
        this.refScene.background = new THREE.Color(0xf0faff);

        const aspect = this.refContainer.clientWidth / this.refContainer.clientHeight;
        const d = 8;
        this.refCamera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 1000);
        this.refCamera.position.set(15, 15, 15);
        this.refCamera.lookAt(0, 0, 0);

        this.refRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.refRenderer.setSize(this.refContainer.clientWidth, this.refContainer.clientHeight);
        this.refRenderer.shadowMap.enabled = true;
        this.refContainer.appendChild(this.refRenderer.domElement);

        const ambient = new THREE.AmbientLight(0xffffff, 0.7);
        this.refScene.add(ambient);
        const sun = new THREE.DirectionalLight(0xffffff, 0.8);
        sun.position.set(10, 20, 10);
        this.refScene.add(sun);

        this.refControls = new OrbitControls(this.refCamera, this.refRenderer.domElement);
        this.refControls.enableDamping = true;
        
        // Handle resize if container changes
        const resizeObserver = new ResizeObserver(() => {
            if (this.refRenderer && this.refContainer.clientWidth > 0) {
                const aspect = this.refContainer.clientWidth / this.refContainer.clientHeight;
                this.refCamera.left = -d * aspect;
                this.refCamera.right = d * aspect;
                this.refCamera.updateProjectionMatrix();
                this.refRenderer.setSize(this.refContainer.clientWidth, this.refContainer.clientHeight);
            }
        });
        resizeObserver.observe(this.refContainer);
    }

    updateReferenceView(brickList) {
        if (!this.refScene) return;
        
        // Clear previous bricks
        const toRemove = [];
        this.refScene.traverse(child => {
            if (child.userData && child.userData.isRefBrick) toRemove.push(child);
        });
        toRemove.forEach(b => this.refScene.remove(b));

        if (!brickList) return;

        const group = new THREE.Group();
        const box = new THREE.Box3();

        brickList.forEach(data => {
            const type = BRICK_TYPES.find(t => t.id === data.typeId);
            if (!type) return;
            const brick = createBrick(type, data.color, 1.0);
            brick.position.set(data.x, data.y, data.z);
            brick.rotation.y = data.ry;
            brick.userData.isRefBrick = true;
            group.add(brick);
            box.expandByObject(brick);
        });

        // Center the group in the ref view
        const center = new THREE.Vector3();
        box.getCenter(center);
        group.children.forEach(child => child.position.sub(center));
        
        this.refScene.add(group);
        
        // Reset controls
        this.refControls.reset();
        this.refCamera.position.set(12, 12, 12);
        this.refCamera.lookAt(0, 0, 0);
    }

    toggleReferenceView(show) {
        if (show) {
            this.referencePanel.classList.remove('hidden');
            // Force a resize check since it was hidden
            setTimeout(() => {
                const aspect = this.refContainer.clientWidth / this.refContainer.clientHeight;
                const d = 8;
                this.refCamera.left = -d * aspect;
                this.refCamera.right = d * aspect;
                this.refCamera.updateProjectionMatrix();
                this.refRenderer.setSize(this.refContainer.clientWidth, this.refContainer.clientHeight);
            }, 10);
        } else {
            this.referencePanel.classList.add('hidden');
        }
    }

    // ═══════════════════════════════════
    // OVERCOOKED MODE LOGIC
    // ═══════════════════════════════════

    setupOvercookedLobby() {
        if (this._overcookedLobbyInitialized) return;
        this._overcookedLobbyInitialized = true;

        const createBtn = document.getElementById('create-overcooked-room-btn');

        // Show player name badge in lobby header
        const lobbyPlayerDisplay = document.getElementById('lobby-player-display');
        if (lobbyPlayerDisplay) {
            const displayName = this.playerName || `Builder ${this.playerId.substring(2, 7).toUpperCase()}`;
            lobbyPlayerDisplay.querySelector('span').innerText = displayName;
        }
        
        if (!db) {
            console.warn('Firebase not connected. Lobby will be empty.');
            const grid = document.getElementById('overcooked-room-grid');
            if (grid) grid.innerHTML = '<div style="color:#666; padding:20px;">Firebase not connected. Check your configuration to use Multiplayer.</div>';
        }

        const roomsRef = db ? ref(db, 'overcooked/rooms') : null;
        if (roomsRef) this.seedDefaultRooms();

        // Note: back navigation is handled by the global back button (see showScreen/setupLobby)

        createBtn.onclick = () => {
            console.log('Create Overcooked Room clicked');
            if (!db) {
                alert('Firebase is not connected. Room creation is disabled in offline mode.');
                return;
            }
            const name = prompt('Enter Room Name (e.g. Yellow Team):', 'Yellow Team');
            if (name) {
                console.log('Creating room with name:', name);
                const newRoomRef = push(roomsRef);
                set(newRoomRef, {
                    id: newRoomRef.key,
                    name: name,
                    status: 'WAITING',
                    players: {}
                }).then(() => {
                    console.log('Room created successfully in Firebase');
                }).catch(err => {
                    console.error('Room creation failed:', err);
                    alert('Failed to create room: ' + err.message);
                });
            }
        };

        // Listen for all overcooked rooms
        if (roomsRef) {
            onValue(roomsRef, (snapshot) => {
                const rooms = snapshot.val();
                this.roomGridEl.innerHTML = '';
                if (rooms) {
                    Object.values(rooms).forEach(room => {
                        const card = document.createElement('div');
                        const colorClass = room.name.toLowerCase().includes('yellow') ? 'room-yellow' : 
                                         room.name.toLowerCase().includes('green') ? 'room-green' :
                                         room.name.toLowerCase().includes('blue') ? 'room-blue' : 'room-red';
                        
                        card.className = `room-card ${colorClass}`;
                        const count = room.players ? Object.keys(room.players).length : 0;
                        
                        card.innerHTML = `
                            <div class="room-icon">🏠</div>
                            <div class="room-name">${room.name}</div>
                            <div class="room-count">${count}/6 Players</div>
                        `;
                        
                        card.onclick = () => this.enterOvercookedRoom(room.id);
                        this.roomGridEl.appendChild(card);
                    });
                }
            });
        }
    }

    async seedDefaultRooms() {
        if (!db) return;
        const defaultRooms = [
            { id: 'room_red', name: 'Red Room' },
            { id: 'room_green', name: 'Green Room' },
            { id: 'room_blue', name: 'Blue Room' },
            { id: 'room_yellow', name: 'Yellow Room' }
        ];

        for (const room of defaultRooms) {
            const roomRef = ref(db, `overcooked/rooms/${room.id}`);
            try {
                const snapshot = await get(roomRef);
                if (!snapshot.exists()) {
                    await set(roomRef, {
                        id: room.id,
                        name: room.name,
                        status: 'WAITING',
                        players: {}
                    });
                }
            } catch (err) {
                console.error('Error seeding room:', room.id, err);
            }
        }
    }

    enterOvercookedRoom(roomId) {
        this.overcookedRoomId = roomId;
        this.timerExpired = false;
        this.toggleReferenceView(false);
        this.showScreen('overcooked-room');
        document.getElementById('overcooked-room-title').innerText = 'Room: ' + roomId.substring(0, 6);

        const readyBtn = document.getElementById('ready-btn');
        readyBtn.onclick = () => {
            this.isReady = !this.isReady;
            set(ref(db, `overcooked/rooms/${roomId}/players/${this.playerId}/ready`), this.isReady);
            readyBtn.innerText = this.isReady ? 'CANCEL READY' : "I'M READY!";
            readyBtn.classList.toggle('active', this.isReady);
        };

        const leaveBtn = document.getElementById('leave-overcooked-btn');
        if (leaveBtn) {
            leaveBtn.onclick = () => {
                if (db) remove(ref(db, `overcooked/rooms/${roomId}/players/${this.playerId}`));
                this.showScreen('overcooked-lobby');
            };
        }

        const displayName = this.playerName || `Builder ${this.playerId.substring(2, 7).toUpperCase()}`;
        const playerRef = db ? ref(db, `overcooked/rooms/${roomId}/players/${this.playerId}`) : null;
        if (playerRef) {
            set(playerRef, {
                id: this.playerId,
                name: displayName,
                ready: false
            });
            // Auto-remove on disconnect so players don't linger
            onDisconnect(playerRef).remove();
        }

        // Listen for this room's players
        const allPlayersRef = db ? ref(db, `overcooked/rooms/${roomId}/players`) : null;
        if (allPlayersRef) {
            onValue(allPlayersRef, (snapshot) => {
                const players = snapshot.val();
                this.readyListEl.innerHTML = '';
                if (players) {
                    const playerArr = Object.values(players);
                    playerArr.forEach(p => {
                        const item = document.createElement('div');
                        item.className = `ready-item ${p.ready ? 'is-ready' : ''} ${p.id === this.playerId ? 'is-me' : ''}`;
                        item.innerHTML = `
                            <div class="status-dot"></div>
                            <span class="player-name">${p.name} ${p.id === this.playerId ? '(You)' : ''}</span>
                            <span class="status-text">${p.ready ? 'READY' : 'WAITING'}</span>
                        `;
                        this.readyListEl.appendChild(item);
                    });

                    // Update count
                    document.getElementById('overcooked-player-count').innerText = `${playerArr.length}/6 Players`;
                    
                    // CHECK START CONDITION
                    const allReady = playerArr.length >= 4 && playerArr.every(p => p.ready);
                    if (allReady && this.gameState === 'WAITING') {
                        this.startOvercookedGame();
                    }
                }
            });
        }

        // Listen for room state (transitions from Waiting to Build)
        const roomStatusPath = `overcooked/rooms/${roomId}/status`;
        const roomStateRef = db ? ref(db, roomStatusPath) : null;
        if (roomStateRef) {
            onValue(roomStateRef, (snapshot) => {
                if (snapshot.val() === 'ROUND_1_BUILD' && this.gameState === 'WAITING') {
                    this.beginOvercookedSession();
                }
            });
        }
    }

    startOvercookedGame() {
        // Only one player needs to trigger the state change
        const roomStateRef = ref(db, `overcooked/rooms/${this.overcookedRoomId}/status`);
        set(roomStateRef, 'ROUND_1_BUILD');
    }

    beginOvercookedSession() {
        this.gameState = 'ROUND_1_BUILD';
        this.timerExpired = false;
        this.toggleReferenceView(false);
        this.overcookedRoomEl.classList.add('hidden');
        this.landingScreen.classList.add('hidden');
        this.uiContainer.classList.remove('hidden');
        this.hudEl.classList.remove('hidden');
        
        // Enter the actual building room (using the same roomId for brick sync)
        this.enterRoom(this.overcookedRoomId);
        
        // Show Round 1 Modal
        this.showModal('Round 1', 'Create the most complex structure your team can build. Be as creative as possible.', '🍳');
        
        // Start 3-minute timer
        this.startTimer(180, () => this.endRound1());
    }

    showModal(title, text, icon) {
        document.getElementById('modal-title').innerText = title;
        document.getElementById('modal-text').innerText = text;
        document.getElementById('modal-icon').innerText = icon;
        this.modalEl.classList.remove('hidden');
        document.getElementById('close-modal-btn').onclick = () => {
            this.modalEl.classList.add('hidden');
        };
    }

    startTimer(seconds, callback) {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.timerExpired = false;
        let timeLeft = seconds;
        const fill = document.getElementById('timer-progress-fill');
        const text = document.getElementById('timer-text');
        
        this.timerInterval = setInterval(() => {
            timeLeft--;
            const m = Math.floor(timeLeft / 60);
            const s = timeLeft % 60;
            text.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            fill.style.width = (timeLeft / seconds * 100) + '%';
            
            if (timeLeft <= 0) {
                clearInterval(this.timerInterval);
                this.timerExpired = true; // LOCK INPUT
                callback();
            }
        }, 1000);
    }

    endRound1() {
        this.gameState = 'ROUND_1_COMPLETE';
        alert('Time is up! Round 1 Complete.');
        
        // Snapshot the structure
        const structure = this.bricks.map(b => ({
            typeId: b.userData.typeId,
            color: b.userData.color,
            x: b.position.x,
            y: b.position.y,
            z: b.position.z,
            ry: b.rotation.y
        }));
        
        const snapshotRef = ref(db, `overcooked/rooms/${this.overcookedRoomId}/snapshot`);
        set(snapshotRef, structure);
        
        // Mark room as complete
        set(ref(db, `overcooked/rooms/${this.overcookedRoomId}/status`), 'ROUND_1_COMPLETE');
        
        // Initiate matching with other finished teams (Pair-Based)
        this.initiateMatching();
    }

    async initiateMatching() {
        this.showModal('Rounding Up Teams...', 'Waiting for another team to match for Round 2 swap.', '⏳');
        
        const queueRef = ref(db, 'overcooked/matching_queue');
        
        // Use a transaction to pick a pair from the queue or join it
        try {
            const result = await runTransaction(queueRef, (currentData) => {
                if (currentData === null) {
                    // Queue is empty, I'm the first one waiting
                    return this.overcookedRoomId;
                } else if (currentData === this.overcookedRoomId) {
                    // I'm already in the queue, stay there
                    return currentData;
                } else {
                    // Someone else is waiting, take them and clear the queue
                    return null;
                }
            });

            if (result.committed) {
                const waitingRoomId = result.snapshot.val();
                if (waitingRoomId && waitingRoomId !== this.overcookedRoomId) {
                    // I found a pair!
                    console.log('Matched with team:', waitingRoomId);
                    // Write the pair link to both rooms
                    set(ref(db, `overcooked/rooms/${this.overcookedRoomId}/pairedWith`), waitingRoomId);
                    set(ref(db, `overcooked/rooms/${waitingRoomId}/pairedWith`), this.overcookedRoomId);
                    this.proceedToRound2(waitingRoomId);
                } else {
                    // I am the one waiting in the queue
                    console.log('Waiting in queue for a partner...');
                    this.waitForPair();
                }
            }
        } catch (err) {
            console.error('Matching Error:', err);
        }
    }

    waitForPair() {
        const pairingRef = ref(db, `overcooked/rooms/${this.overcookedRoomId}/pairedWith`);
        onValue(pairingRef, (snapshot) => {
            const partnerId = snapshot.val();
            if (partnerId && this.gameState === 'ROUND_1_COMPLETE') {
                console.log('Partner found via listener:', partnerId);
                this.proceedToRound2(partnerId);
            }
        }, { onlyOnce: false });
    }

    async proceedToRound2(otherRoomId) {
        this.gameState = 'ROUND_2_BUILD';
        this.modalEl.classList.add('hidden');
        
        // Clear the current building area for the new round
        // Since all players in the room will execute this, it's redundant but safe 
        // to call remove() multiple times. This triggers onChildRemoved for all clients.
        if (this.bricksRef) {
            remove(this.bricksRef);
        }
        
        // Structure Swap: Fetch the paired room's snapshot
        const snapshot = await get(ref(db, `overcooked/rooms/${otherRoomId}/snapshot`));
        const assignedStructure = snapshot.val();
        
        // Assign Role
        const roles = ['BUILDER', 'REMOVER', 'SELECTOR', 'COLOR_PICKER', 'ROTATOR'];
        this.currentRole = roles[Math.floor(Math.random() * roles.length)];
        this.displayRole(this.currentRole);
        
        // Show assigned structure as reference (ghost)
        this.createImportGhost(assignedStructure);
        
        // Populate the floating reference view
        this.updateReferenceView(assignedStructure);
        this.toggleReferenceView(true);
        
        this.showModal('Round 2', 'Recreate the assigned structure! Each player has a restricted role. Coordinate well.', '🔥');
        this.startTimer(600, () => this.endGame());
    }

    displayRole(role) {
        const descriptions = {
            'BUILDER': 'Can only place blocks',
            'REMOVER': 'Can only delete blocks',
            'SELECTOR': 'Can only select objects',
            'COLOR_PICKER': 'Can only change colors',
            'ROTATOR': 'Can only rotate blocks'
        };
        document.getElementById('role-name').innerText = role;
        document.getElementById('role-desc').innerText = descriptions[role];
    }

    endGame() {
        this.gameState = 'GAME_COMPLETE';
        this.showModal('Game Complete!', 'Great work! Check your recreated structure against the original.', '🏆');
        if (this.timerInterval) clearInterval(this.timerInterval);
    }

    canPerform(roleRequired) {
        if (this.gameMode !== 'overcooked' || this.gameState !== 'ROUND_2_BUILD') return true;
        if (this.currentRole === roleRequired) return true;
        
        // Show brief warning on role card if wrong action
        const card = document.getElementById('role-card');
        card.style.background = '#ff4d4d';
        setTimeout(() => card.style.background = '#1cb0f6', 500);
        return false;
    }
}

new LegoGame();
