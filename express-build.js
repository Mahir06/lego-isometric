/**
 * Express Build Mode
 * ------------------
 * Each player gets a dedicated build zone. A prompt is given (facilitator or random).
 * 5 minutes to build. Then everyone spectates all builds freely.
 */

import * as THREE from 'three';
import { db } from './firebase-config.js';
import { ref, onValue, set, push, remove, get, onDisconnect, off } from 'firebase/database';

const DEFAULT_PROMPTS = [
    "Build yourself at work — how you see your role, strengths, and approach",
    "Build your ideal team — what makes a team work well for you",
    "Build your ideal manager — qualities, behaviours, and expectations",
    "Build what \"good collaboration\" looks like to you",
    "Build a challenging work situation you've faced — represent the problem, not the solution",
    "Build how you contribute to a team — what you bring that others rely on",
    "Build what trust in a team looks like",
    "Build your current team dynamic — how things actually function today",
    "Build a barrier that affects teamwork — something that slows or blocks collaboration",
    "Build your ideal work environment — physical, cultural, or structural"
];

const PROMPT_SUBTEXT = "This round is about using building as a way to think and express. Instead of explaining directly, you'll create a model that represents your ideas or experiences at work. There's no right or wrong answer — focus on what the model means to you, and use it to share your perspective with the group.";

const ZONE_SIZE = 10;       // 10×10 studs per player
const ZONE_SPACING = 14;    // 14 studs apart (10 + 4 gap)
const BUILD_DURATION = 300;  // 5 minutes in seconds

const ZONE_COLORS = [
    0xff4757, // red
    0x1cb0f6, // blue
    0x58cc02, // green
    0xff9f00, // amber
    0xa855f7, // purple
    0xff6b81, // pink
];

export class ExpressBuildMode {
    constructor(game) {
        this.game = game;
        this.worldCode = null;
        this.roomId = null;
        this.prompt = null;
        this.subtext = PROMPT_SUBTEXT;
        this.zoneIndex = -1;
        this.zoneOrigin = new THREE.Vector3();
        this.zonePlanes = [];
        this.zoneLabels = [];
        this.gameState = 'WAITING';   // WAITING | BUILDING | SPECTATING
        this.timerInterval = null;
        this.buildDuration = BUILD_DURATION;
        this._lobbyInitialized = false;
        this._facInitialized = false;
        this._roomListeners = [];
    }

    // ─── LOBBY (player-facing) ────────────────────────────────────────────────
    setupLobby(worldCode) {
        this.worldCode = worldCode;
        if (this._lobbyInitialized) return;
        this._lobbyInitialized = true;

        const lobbyCodeEl = document.getElementById('express-lobby-code');
        if (lobbyCodeEl) lobbyCodeEl.querySelector('span').innerText = worldCode;

        const lobbyPlayerDisplay = document.getElementById('express-lobby-player-display');
        if (lobbyPlayerDisplay) {
            const displayName = this.game.playerName || `Builder ${this.game.playerId.substring(2, 7).toUpperCase()}`;
            lobbyPlayerDisplay.querySelector('span').innerText = displayName;
        }

        const createBtn = document.getElementById('create-express-room-btn');
        const roomsRef = db ? ref(db, `rooms/${worldCode}/express_rooms`) : null;

        if (roomsRef) this.seedDefaultRooms(worldCode);

        createBtn.onclick = () => {
            if (!db) { alert('Firebase is not connected.'); return; }
            const name = prompt('Enter Room Name:', 'Purple Team');
            if (name) {
                const newRef = push(roomsRef);
                set(newRef, { id: newRef.key, name, status: 'WAITING', players: {} });
            }
        };

        if (roomsRef) {
            onValue(roomsRef, (snapshot) => {
                const rooms = snapshot.val();
                const grid = document.getElementById('express-room-grid');
                grid.innerHTML = '';
                if (rooms) {
                    Object.values(rooms).forEach(room => {
                        const card = document.createElement('div');
                        const colorClass = room.name.toLowerCase().includes('yellow') ? 'room-yellow' :
                                           room.name.toLowerCase().includes('green')  ? 'room-green'  :
                                           room.name.toLowerCase().includes('blue')   ? 'room-blue'   : 'room-red';
                        card.className = `room-card ${colorClass}`;
                        const count = room.players ? Object.keys(room.players).length : 0;
                        card.innerHTML = `
                            <div class="room-icon">🏠</div>
                            <div class="room-name">${room.name}</div>
                            <div class="room-count">${count}/6 Players</div>
                        `;
                        card.onclick = () => this.enterRoom(room.id);
                        grid.appendChild(card);
                    });
                }
            });
        }
    }

    async seedDefaultRooms(worldCode) {
        if (!db) return;
        const defaults = [
            { id: 'room_red',    name: 'Red Room'    },
            { id: 'room_green',  name: 'Green Room'  },
            { id: 'room_blue',   name: 'Blue Room'   },
            { id: 'room_yellow', name: 'Yellow Room'  }
        ];
        for (const room of defaults) {
            const r = ref(db, `rooms/${worldCode}/express_rooms/${room.id}`);
            try {
                const snap = await get(r);
                if (!snap.exists()) {
                    await set(r, { id: room.id, name: room.name, status: 'WAITING', players: {} });
                }
            } catch (e) { console.error('Seed error:', e); }
        }
    }

    enterRoom(roomId) {
        this.roomId = roomId;
        this.game.showScreen('express-room');
        document.getElementById('express-room-title').innerText = 'Room: ' + roomId.substring(0, 8);

        const readyBtn = document.getElementById('express-ready-btn');
        let isReady = false;
        readyBtn.onclick = () => {
            isReady = !isReady;
            set(ref(db, `rooms/${this.worldCode}/express_rooms/${roomId}/players/${this.game.playerId}/ready`), isReady);
            readyBtn.innerText = isReady ? 'CANCEL READY' : "I'M READY!";
            readyBtn.classList.toggle('active', isReady);
        };

        const leaveBtn = document.getElementById('express-leave-btn');
        if (leaveBtn) {
            leaveBtn.onclick = () => {
                if (db) remove(ref(db, `rooms/${this.worldCode}/express_rooms/${roomId}/players/${this.game.playerId}`));
                this.game.showScreen('express-lobby');
            };
        }

        // Register player
        const displayName = this.game.playerName || `Builder ${this.game.playerId.substring(2, 7).toUpperCase()}`;
        const playerRef = ref(db, `rooms/${this.worldCode}/express_rooms/${roomId}/players/${this.game.playerId}`);
        set(playerRef, { id: this.game.playerId, name: displayName, ready: false });
        onDisconnect(playerRef).remove();

        // Listen for players
        const allPlayersRef = ref(db, `rooms/${this.worldCode}/express_rooms/${roomId}/players`);
        onValue(allPlayersRef, (snapshot) => {
            const players = snapshot.val();
            const listEl = document.getElementById('express-ready-list');
            listEl.innerHTML = '';
            if (players) {
                const arr = Object.values(players);
                arr.forEach(p => {
                    const item = document.createElement('div');
                    item.className = `ready-item ${p.ready ? 'is-ready' : ''} ${p.id === this.game.playerId ? 'is-me' : ''}`;
                    item.innerHTML = `
                        <div class="status-dot"></div>
                        <span class="player-name">${p.name} ${p.id === this.game.playerId ? '(You)' : ''}</span>
                        <span class="status-text">${p.ready ? 'READY' : 'WAITING'}</span>
                    `;
                    listEl.appendChild(item);
                });
                document.getElementById('express-player-count').innerText = `${arr.length}/6 Players`;
            }
        });

        // Listen for room status changes (facilitator may start)
        const statusRef = ref(db, `rooms/${this.worldCode}/express_rooms/${roomId}/status`);
        onValue(statusRef, (snapshot) => {
            const status = snapshot.val();
            if (status === 'BUILDING' && this.gameState === 'WAITING') {
                this.onBuildStarted();
            } else if (status === 'SPECTATING' && this.gameState === 'BUILDING') {
                this.onSpectateStarted();
            } else if (status === 'ENDED') {
                this.onGameEnded();
            }
        });
    }

    // ─── FACILITATOR DASHBOARD ────────────────────────────────────────────────
    setupFacilitatorDashboard(worldCode) {
        this.worldCode = worldCode;
        if (this._facInitialized) return;
        this._facInitialized = true;

        // Prompt input
        const promptInput = document.getElementById('express-prompt-input');
        const startBtn = document.getElementById('express-fac-start');
        const endBtn = document.getElementById('express-fac-end');

        startBtn.onclick = async () => {
            const customPrompt = promptInput.value.trim();
            const prompt = customPrompt || DEFAULT_PROMPTS[Math.floor(Math.random() * DEFAULT_PROMPTS.length)];

            if (!confirm(`Start round with prompt:\n"${prompt}"\n\nAll waiting rooms will begin building.`)) return;

            // Write prompt to all waiting rooms and start them
            const snapshot = await get(ref(db, `rooms/${worldCode}/express_rooms`));
            const rooms = snapshot.val();
            if (rooms) {
                Object.values(rooms).forEach(room => {
                    if (room.status === 'WAITING') {
                        set(ref(db, `rooms/${worldCode}/express_rooms/${room.id}/prompt`), prompt);
                        set(ref(db, `rooms/${worldCode}/express_rooms/${room.id}/subtext`), PROMPT_SUBTEXT);
                        set(ref(db, `rooms/${worldCode}/express_rooms/${room.id}/status`), 'BUILDING');
                        set(ref(db, `rooms/${worldCode}/express_rooms/${room.id}/startedAt`), Date.now());
                    }
                });
            }
        };

        endBtn.onclick = async () => {
            if (!confirm('End building for all rooms and start spectating?')) return;
            const snapshot = await get(ref(db, `rooms/${worldCode}/express_rooms`));
            const rooms = snapshot.val();
            if (rooms) {
                Object.values(rooms).forEach(room => {
                    if (room.status === 'BUILDING') {
                        set(ref(db, `rooms/${worldCode}/express_rooms/${room.id}/status`), 'SPECTATING');
                    }
                });
            }
        };

        // End Game — reset all rooms to WAITING and kick everyone back to lobby
        const resetBtn = document.getElementById('express-fac-reset');
        if (resetBtn) {
            resetBtn.onclick = async () => {
                if (!confirm('End the game? This will send ALL players back to the lobby.')) return;
                const snapshot = await get(ref(db, `rooms/${worldCode}/express_rooms`));
                const rooms = snapshot.val();
                if (rooms) {
                    Object.values(rooms).forEach(room => {
                        set(ref(db, `rooms/${worldCode}/express_rooms/${room.id}/status`), 'ENDED');
                    });

                    // After a short delay, reset rooms to WAITING so new games can start
                    setTimeout(async () => {
                        const snap2 = await get(ref(db, `rooms/${worldCode}/express_rooms`));
                        const rooms2 = snap2.val();
                        if (rooms2) {
                            Object.values(rooms2).forEach(room => {
                                set(ref(db, `rooms/${worldCode}/express_rooms/${room.id}/status`), 'WAITING');
                                // Clear old bricks and prompt
                                set(ref(db, `rooms/${worldCode}/express_rooms/${room.id}/prompt`), null);
                                set(ref(db, `rooms/${worldCode}/express_rooms/${room.id}/subtext`), null);
                                set(ref(db, `rooms/${worldCode}/express_rooms/${room.id}/startedAt`), null);
                            });
                        }
                    }, 2000);
                }
            };
        }

        // Time setting
        const timeInput = document.getElementById('express-fac-time');
        if (timeInput) {
            timeInput.value = BUILD_DURATION;
        }

        // Room list
        const roomsRef = db ? ref(db, `rooms/${worldCode}/express_rooms`) : null;
        if (roomsRef) {
            onValue(roomsRef, (snapshot) => {
                const rooms = snapshot.val();
                const listEl = document.getElementById('express-fac-room-list');
                listEl.innerHTML = '';
                if (rooms) {
                    Object.values(rooms).forEach(room => {
                        const card = document.createElement('div');
                        card.className = 'fac-room-card-premium';
                        const players = room.players ? Object.values(room.players) : [];
                        const playerNames = players.map(p => p.name).join(', ') || 'No players yet';

                        let statusText = room.status;
                        let statusClass = 'status-waiting';
                        if (room.status === 'BUILDING') { statusClass = 'status-build'; statusText = 'BUILDING'; }
                        else if (room.status === 'SPECTATING') { statusClass = 'status-complete'; statusText = 'SPECTATING'; }

                        card.innerHTML = `
                            <div class="room-status-dot ${statusClass}"></div>
                            <div class="fac-room-info">
                                <h4>${room.name}</h4>
                                <p>Status: <span style="font-weight:700; color: ${statusClass === 'status-build' ? '#1cb0f6' : '#666'}">${statusText}</span></p>
                                <p style="font-size: 0.75rem; color: #888; margin-top: 5px;">👤 ${playerNames}</p>
                                ${room.prompt ? `<p style="font-size: 0.7rem; color: #1cb0f6; margin-top: 5px; font-style: italic;">"${room.prompt.substring(0, 60)}..."</p>` : ''}
                            </div>
                            <div class="fac-room-players">${players.length}/6 Players</div>
                        `;

                        card.onclick = () => this.spectateRoom(room.id);
                        listEl.appendChild(card);
                    });
                } else {
                    listEl.innerHTML = '<div style="text-align: center; color: #aaa; margin-top: 50px;"><p>No active rooms detected.</p></div>';
                }
            });
        }

        // Exit
        document.getElementById('express-fac-exit').onclick = () => {
            if (confirm('Exit Mission Control?')) window.location.reload();
        };

        // Spectate back button
        document.getElementById('fac-spectate-back').onclick = () => {
            if (this.game.bricksRef) off(this.game.bricksRef);
            this.game.bricks.forEach(b => this.game.scene.remove(b));
            this.game.bricks = [];
            this.cleanupZoneVisuals();

            this.game.landingScreen.classList.remove('hidden');
            this.game.uiContainer.classList.add('hidden');

            this.game.showScreen('express-facilitator-dashboard');
            document.getElementById('fac-spectate-back').classList.add('hidden');
            document.getElementById('sidebar')?.classList.add('hidden');
        };
    }

    spectateRoom(roomId) {
        const world = this.worldCode;
        const displayCode = `${world}_express_${roomId}`;
        this.game.enterRoom(displayCode);

        // Load all players' zone visuals
        get(ref(db, `rooms/${world}/express_rooms/${roomId}/players`)).then(snap => {
            const players = snap.val();
            if (players) {
                const sorted = Object.values(players).sort((a, b) => a.id.localeCompare(b.id));
                this.createAllZoneVisuals(sorted);
            }
        });

        document.getElementById('fac-spectate-back').classList.remove('hidden');

        // Expand floor + grid for zone coverage & force resize
        get(ref(db, `rooms/${world}/express_rooms/${roomId}/players`)).then(snap => {
            const players = snap.val();
            if (players) {
                this.expandFloorForZones(Object.keys(players).length);
            }
        });
        this.forceRendererResize();
    }

    // ─── BUILD PHASE ──────────────────────────────────────────────────────────
    async onBuildStarted() {
        this.gameState = 'BUILDING';

        // Fetch prompt + players
        const roomSnap = await get(ref(db, `rooms/${this.worldCode}/express_rooms/${this.roomId}`));
        const roomData = roomSnap.val();
        this.prompt = roomData.prompt || DEFAULT_PROMPTS[Math.floor(Math.random() * DEFAULT_PROMPTS.length)];
        this.subtext = roomData.subtext || PROMPT_SUBTEXT;

        // Assign build zones (must be before enterRoom so floor expansion uses correct count)
        const players = roomData.players ? Object.values(roomData.players).sort((a, b) => a.id.localeCompare(b.id)) : [];
        const myIndex = players.findIndex(p => p.id === this.game.playerId);
        this.zoneIndex = myIndex >= 0 ? myIndex : 0;
        this.zoneOrigin.set(this.zoneIndex * ZONE_SPACING, 0, 0);

        // Enter the building room
        const roomCode = `${this.worldCode}_express_${this.roomId}`;
        this.game.landingScreen.classList.add('hidden');
        this.game.uiContainer.classList.remove('hidden');
        this.game.enterRoom(roomCode);

        // Expand floor + grid to cover all build zones
        this.expandFloorForZones(players.length);

        // Force renderer resize (viewport was hidden, so dimensions may be stale)
        this.forceRendererResize();

        // Write zone index to firebase for other clients
        set(ref(db, `rooms/${this.worldCode}/express_rooms/${this.roomId}/players/${this.game.playerId}/zoneIndex`), this.zoneIndex);

        // Create zone visuals for all players
        this.createAllZoneVisuals(players);

        // Center camera on player's zone
        this.game.controls.target.set(this.zoneOrigin.x, 0, this.zoneOrigin.z);
        this.game.camera.position.set(this.zoneOrigin.x + 20, 20, this.zoneOrigin.z + 20);
        this.game.camera.lookAt(this.zoneOrigin.x, 0, this.zoneOrigin.z);
        this.game.controls.update();

        // Show HUD
        this.showBuildHUD();

        // Show instruction modal
        this.game.showModal('Express Build', `${this.prompt}\n\n${this.subtext}`, '🎨');

        // Start timer
        const duration = roomData.buildDuration || BUILD_DURATION;
        this.startTimer(duration, () => this.endBuildPhase());
    }

    createAllZoneVisuals(players) {
        this.cleanupZoneVisuals();

        players.forEach((p, i) => {
            const originX = i * ZONE_SPACING;
            const color = ZONE_COLORS[i % ZONE_COLORS.length];

            // Colored ground plane
            const planeGeom = new THREE.PlaneGeometry(ZONE_SIZE, ZONE_SIZE);
            planeGeom.rotateX(-Math.PI / 2);
            const planeMat = new THREE.MeshBasicMaterial({
                color: color,
                transparent: true,
                opacity: 0.12,
                side: THREE.DoubleSide
            });
            const plane = new THREE.Mesh(planeGeom, planeMat);
            plane.position.set(originX, 0.01, 0);
            plane.userData.isZoneVisual = true;
            this.game.scene.add(plane);
            this.zonePlanes.push(plane);

            // Zone border (thin lines)
            const borderGeom = new THREE.EdgesGeometry(new THREE.PlaneGeometry(ZONE_SIZE, ZONE_SIZE));
            const borderMat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.5 });
            const border = new THREE.LineSegments(borderGeom, borderMat);
            border.rotation.x = -Math.PI / 2;
            border.position.set(originX, 0.02, 0);
            border.userData.isZoneVisual = true;
            this.game.scene.add(border);
            this.zonePlanes.push(border);

            // Player name label (3D text via sprite)
            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
            ctx.fillRect(0, 0, 512, 64);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 36px Nunito, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const displayName = p.id === this.game.playerId ? `${p.name} (You)` : p.name;
            ctx.fillText(displayName, 256, 32);

            const texture = new THREE.CanvasTexture(canvas);
            const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
            const sprite = new THREE.Sprite(spriteMat);
            sprite.scale.set(6, 0.75, 1);
            sprite.position.set(originX, 0.5, -ZONE_SIZE / 2 - 1);
            sprite.userData.isZoneVisual = true;
            this.game.scene.add(sprite);
            this.zoneLabels.push(sprite);
        });
    }

    cleanupZoneVisuals() {
        [...this.zonePlanes, ...this.zoneLabels].forEach(obj => {
            this.game.scene.remove(obj);
        });
        this.zonePlanes = [];
        this.zoneLabels = [];
    }

    /**
     * Expand the invisible floor plane and visible grid so that all
     * player zones are covered by the raycast surface.
     * 6 players × ZONE_SPACING(14) = 84 studs. We pad generously.
     */
    expandFloorForZones(playerCount) {
        const totalSpan = Math.max(playerCount, 1) * ZONE_SPACING;
        const neededSize = totalSpan + 800; // massive padding to prevent grid clipping when zoomed out
        const centerX = ((playerCount - 1) * ZONE_SPACING) / 2;

        // Replace the invisible floor used for raycasting
        if (this.game.floor) {
            this.game.scene.remove(this.game.floor);
        }
        const floorGeom = new THREE.PlaneGeometry(neededSize, neededSize);
        floorGeom.rotateX(-Math.PI / 2);
        this.game.floor = new THREE.Mesh(floorGeom, new THREE.MeshBasicMaterial({ visible: false }));
        this.game.floor.position.set(centerX, 0, 0);
        this.game.scene.add(this.game.floor);

        // Replace the visible grid helper
        if (this.game.grid) {
            this.game.scene.remove(this.game.grid);
        }
        const gridSize = Math.ceil(neededSize / 2) * 2; // round to even
        this.game.grid = new THREE.GridHelper(gridSize, gridSize, 0x000000, 0x000000);
        this.game.grid.material.opacity = 0.1;
        this.game.grid.material.transparent = true;
        this.game.grid.position.set(centerX, 0, 0);
        this.game.scene.add(this.game.grid);
    }

    /**
     * Force the WebGL renderer to resize to the current canvas container.
     * Fires at staggered intervals to catch CSS transitions finishing.
     */
    forceRendererResize() {
        const doResize = () => {
            if (this.game && typeof this.game.onWindowResize === 'function') {
                this.game.onWindowResize();
            }
        };
        // Fire at multiple intervals to catch CSS layout settling
        setTimeout(doResize, 50);
        setTimeout(doResize, 200);
        setTimeout(doResize, 500);
    }

    showBuildHUD() {
        const hud = document.getElementById('express-build-hud');
        if (hud) {
            hud.classList.remove('hidden');
            document.getElementById('express-prompt-display').innerText = this.prompt;
            document.getElementById('express-subtext-display').innerText = this.subtext;
        }
    }

    hideBuildHUD() {
        const hud = document.getElementById('express-build-hud');
        if (hud) hud.classList.add('hidden');
    }

    // ─── ZONE ENFORCEMENT ─────────────────────────────────────────────────────
    isInMyZone(position) {
        if (this.gameState !== 'BUILDING') return false;
        const halfZone = ZONE_SIZE / 2;
        const ox = this.zoneOrigin.x;
        const oz = this.zoneOrigin.z;
        return (
            position.x >= ox - halfZone &&
            position.x <= ox + halfZone &&
            position.z >= oz - halfZone &&
            position.z <= oz + halfZone
        );
    }

    // ─── TIMER ────────────────────────────────────────────────────────────────
    startTimer(seconds, callback) {
        if (this.timerInterval) clearInterval(this.timerInterval);
        const endTime = Date.now() + seconds * 1000;
        const timerEl = document.getElementById('express-timer-text');
        const fillEl = document.getElementById('express-timer-fill');

        this.timerInterval = setInterval(() => {
            const timeLeft = Math.max(0, Math.round((endTime - Date.now()) / 1000));
            const m = Math.floor(timeLeft / 60);
            const s = timeLeft % 60;
            if (timerEl) timerEl.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            if (fillEl) fillEl.style.width = (timeLeft / seconds * 100) + '%';

            if (timeLeft <= 0) {
                clearInterval(this.timerInterval);
                callback();
            }
        }, 1000);
    }

    // ─── END BUILD → SPECTATE ─────────────────────────────────────────────────
    endBuildPhase() {
        // Mark room as spectating in Firebase (one client triggers)
        set(ref(db, `rooms/${this.worldCode}/express_rooms/${this.roomId}/status`), 'SPECTATING');
        this.onSpectateStarted();
    }

    onSpectateStarted() {
        this.gameState = 'SPECTATING';
        if (this.timerInterval) clearInterval(this.timerInterval);

        // Lock all building controls
        this.lockBuildingControls();

        // Show spectate banner
        this.showSpectateBanner();

        // Zoom out to show all zones
        this.zoomOutToAll();

        // Resize after sidebar collapse (CSS transition takes ~300ms)
        this.forceRendererResize();
    }

    /**
     * Facilitator ended the game — send everyone back to the lobby.
     */
    onGameEnded() {
        this.gameState = 'WAITING';
        if (this.timerInterval) clearInterval(this.timerInterval);

        // Clean up scene
        this.cleanupZoneVisuals();
        this.hideBuildHUD();

        // Remove spectate banner
        const banner = document.getElementById('express-spectate-banner');
        if (banner) banner.classList.add('hidden');

        // Detach brick listeners
        if (this.game.bricksRef) off(this.game.bricksRef);
        this.game.bricks.forEach(b => this.game.scene.remove(b));
        this.game.bricks = [];

        // Return to Express Build lobby
        this.game.landingScreen.classList.remove('hidden');
        this.game.uiContainer.classList.add('hidden');
        this.game.showScreen('express-lobby');

        // Restore sidebar visibility
        this.game.uiContainer.classList.remove('sidebar-collapsed');
        document.getElementById('sidebar')?.classList.remove('hidden');

        // Restore toolbar buttons
        ['undo-btn', 'clear-btn', 'export-btn', 'import-btn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.remove('hidden');
        });
    }

    lockBuildingControls() {
        // Hide sidebar (brick/color selectors)
        const sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.classList.add('hidden');

        // Hide building toolbar buttons
        ['undo-btn', 'clear-btn', 'export-btn', 'import-btn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.add('hidden');
        });

        // Hide ghost brick
        if (this.game.ghostBrick) {
            this.game.ghostBrick.visible = false;
        }

        // Collapse sidebar
        this.game.uiContainer.classList.add('sidebar-collapsed');
    }

    showSpectateBanner() {
        this.hideBuildHUD();

        let banner = document.getElementById('express-spectate-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'express-spectate-banner';
            banner.className = 'express-spectate-banner';
            document.getElementById('ui-container').appendChild(banner);
        }
        banner.classList.remove('hidden');
        banner.innerHTML = `
            <div class="spectate-banner-content">
                <span class="spectate-icon">👀</span>
                <span class="spectate-title">Spectate Mode</span>
                <span class="spectate-hint">Pan, rotate, and zoom to explore everyone's builds!</span>
            </div>
        `;
    }

    zoomOutToAll() {
        // Find bounds of all bricks + zone planes
        const box = new THREE.Box3();
        this.game.bricks.forEach(b => box.expandByObject(b));
        this.zonePlanes.forEach(p => box.expandByObject(p));

        if (!box.isEmpty()) {
            const center = new THREE.Vector3();
            box.getCenter(center);
            this.game.controls.target.copy(center);
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.z) * 0.8;
            this.game.camera.position.set(center.x + maxDim, maxDim * 0.8, center.z + maxDim);
            this.game.camera.lookAt(center);
            this.game.controls.update();
        }
    }

    // ─── CLEANUP ──────────────────────────────────────────────────────────────
    cleanup() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.cleanupZoneVisuals();
        this._roomListeners.forEach(unsub => { try { unsub(); } catch(e) {} });
        this._roomListeners = [];
    }
}
