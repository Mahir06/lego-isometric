console.log('LEGO Builder V4 Loaded');

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { createBrick, BRICK_TYPES, BRICK_COLORS } from './bricks.js';
import { db } from './firebase-config.js';
import { ref, onValue, set, push, remove, onChildAdded, onChildRemoved } from 'firebase/database';

class LegoGame {
    constructor() {
        console.log('Initializing LegoGame V4...');
        this.canvas = document.getElementById('game-canvas');
        this.container = document.getElementById('game-canvas-container');
        this.landingScreen = document.getElementById('landing-screen');
        this.roomCodeDisplay = document.getElementById('room-code-display');
        
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
        this.selectionState = 'none'; // none, selecting, selection-ready
        this.importGhost = null; // Group for importing modules
        this.importPivot = new THREE.Vector3();

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
                    
                    if (brick && brick.userData.height) {
                        pos.y = brick.position.y + brick.userData.height;
                    } else {
                        const hitBox = new THREE.Box3().setFromObject(intersect.object);
                        pos.y = hitBox.max.y;
                        if (intersect.object.geometry && intersect.object.geometry.type === 'CylinderGeometry' && intersect.object.scale.y !== 1) {
                            pos.y -= 0.2;
                        }
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

        joinBtn.onclick = () => {
            const code = roomInput.value.trim().toUpperCase();
            if (code.length === 6) {
                this.enterRoom(code);
            } else {
                alert('Please enter a 6-digit room code');
            }
        };

        createBtn.onclick = () => {
            const code = Math.random().toString(36).substring(2, 8).toUpperCase();
            this.enterRoom(code);
        };
    }

    enterRoom(code) {
        console.log('Entering Room:', code);
        this.roomCode = code;
        if (this.roomCodeDisplay) this.roomCodeDisplay.innerText = code;
        this.landingScreen.classList.add('hidden');
        document.getElementById('ui-container').classList.remove('hidden');
        
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
                brick.castShadow = true;
                brick.receiveShadow = true;
                
                this.scene.add(brick);
                this.bricks.push(brick);
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
            const brickData = {
                typeId: this.currentBrickType.id,
                color: this.currentBrickColor,
                opacity: BRICK_COLORS.find(c => c.hex === this.currentBrickColor)?.opacity || 1.0,
                x: this.ghostBrick.position.x,
                y: this.ghostBrick.position.y,
                z: this.ghostBrick.position.z,
                ry: this.ghostBrick.rotation.y
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
                ry: worldEuler.y
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
        if (this.controls) this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}

new LegoGame();
