import * as THREE from 'three';
import { db } from './firebase-config.js';
import { ref, onValue, set, push, remove, get, onDisconnect, off } from 'firebase/database';

const DEFAULT_IMPOSTER_PAIRS = [
    { majority: "Apple", imposter: "Orange" },
    { majority: "Car", imposter: "Truck" },
    { majority: "Cat", imposter: "Dog" },
    { majority: "Sun", imposter: "Moon" },
    { majority: "Coffee", imposter: "Tea" },
    { majority: "Pizza", imposter: "Burger" },
    { majority: "Guitar", imposter: "Piano" },
    { majority: "Ocean", imposter: "Lake" },
    { majority: "Airplane", imposter: "Helicopter" },
    { majority: "Sword", imposter: "Shield" }
];

const ZONE_SPACING = 14;
const ZONE_SIZE = 10;
const DEFAULT_BUILD_DURATION = 120; // 2 minutes
const DEFAULT_SPECTATE_DURATION = 120; // 2 minutes

export class ImposterBuilderMode {
    constructor(game) {
        this.game = game;
        this.worldCode = game.worldCode;
        this.roomId = null;
        
        // State
        this.gameState = 'WAITING'; // WAITING, BUILDING, SPECTATING, VOTING, ENDED
        this.imposterId = null;
        this.majorityWord = "";
        this.imposterWord = "";
        this.myWord = "";
        this.activePlayers = {};
        this.eliminated = {};
        this.isEliminated = false;

        // Visuals
        this.zoneOrigin = new THREE.Vector3(0, 0, 0);
        this.zoneIndex = 0;
        this.zonePlanes = [];
        this.zoneLabels = [];

        // Timers
        this.timerInterval = null;
    }

    // ─── LOBBY ──────────────────────────────────────────────────────────────
    setupLobby() {
        this.worldCode = this.game.worldCode || "";
        const lobbyCodeEl = document.getElementById('imposter-lobby-code');
        if (lobbyCodeEl) lobbyCodeEl.innerHTML = `WORLD: <span style="color:#1cb0f6; font-weight:900;">${this.worldCode}</span>`;
        const lobbyPlayerEl = document.getElementById('imposter-lobby-player-display');
        if (lobbyPlayerEl) lobbyPlayerEl.innerHTML = `👤 <span>${this.game.playerName}</span>`;

        this.game.landingScreen.classList.remove('hidden');
        this.game.showScreen('imposter-lobby');

        // Initial Seed of 4 rooms
        const defaultRooms = ["red", "blue", "green", "yellow"];
        defaultRooms.forEach(color => {
            get(ref(db, `rooms/${this.worldCode}/imposter_rooms/${color}`)).then(snap => {
                if (!snap.exists()) {
                    set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${color}`), {
                        id: color,
                        name: color.charAt(0).toUpperCase() + color.slice(1) + " Room",
                        color: color,
                        status: 'WAITING',
                        players: {}
                    });
                }
            });
        });

        // Listen for all Imposter rooms
        const roomsRef = ref(db, `rooms/${this.worldCode}/imposter_rooms`);
        onValue(roomsRef, (snapshot) => {
            const data = snapshot.val() || {};
            this.renderRoomGrid(data);
        });

        document.getElementById('create-imposter-room-btn').onclick = () => {
            const tempId = Math.random().toString(36).substring(2, 6);
            set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${tempId}`), {
                id: tempId,
                name: `Custom Room ${tempId.toUpperCase()}`,
                color: 'gray',
                status: 'WAITING',
                players: {}
            });
        };
    }

    renderRoomGrid(roomsData) {
        const grid = document.getElementById('imposter-room-grid');
        if (!grid) return;
        grid.innerHTML = '';

        Object.values(roomsData).forEach(room => {
            const playerCount = room.players ? Object.keys(room.players).length : 0;
            const isFull = playerCount >= 6;
            const inProgress = room.status !== 'WAITING';

            const card = document.createElement('div');
            card.className = 'room-card';

            // Add top border
            if (room.color && room.color !== 'gray') {
                const colors = { red: '#ff4b4b', green: '#8bc34a', blue: '#1cb0f6', yellow: '#ffeb3b' };
                card.style.borderTop = `4px solid ${colors[room.color] || room.color}`;
            }

            let statusText = '';
            if (inProgress) statusText = ` <span style="font-size:0.7em; color:#ff9800;">(In Progress)</span>`;
            else if (isFull) statusText = ` <span style="font-size:0.7em; color:#ff4b4b;">(Full)</span>`;

            card.innerHTML = `
                <div class="room-icon">🎭</div>
                <div class="room-name">${room.name}${statusText}</div>
                <div class="room-count">${playerCount}/6 Players</div>
            `;

            if (this.game.isFacilitator) {
                card.onclick = () => this.spectateRoom(room.id);
            } else if (!inProgress && !isFull) {
                card.onclick = () => this.joinRoom(room.id);
            }

            grid.appendChild(card);
        });
    }

    joinRoom(roomId) {
        this.roomId = roomId;
        this.game.showScreen('imposter-room');
        const titleEl = document.getElementById('imposter-room-title');
        if (titleEl) titleEl.innerText = `Room ${roomId.toUpperCase()}`;

        // Join room in FB
        set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${roomId}/players/${this.game.playerId}`), {
            id: this.game.playerId,
            name: this.game.playerName,
            ready: false
        });

        // Listen for players in this room
        const playersRef = ref(db, `rooms/${this.worldCode}/imposter_rooms/${roomId}/players`);
        onValue(playersRef, (snapshot) => {
            const players = snapshot.val() || {};
            this.renderReadyList(players);
            const count = Object.keys(players).length;
            const countEl = document.getElementById('imposter-player-count');
            if (countEl) countEl.innerText = `${count}/6 Players`;
        });

        // Listen for room status changes
        const statusRef = ref(db, `rooms/${this.worldCode}/imposter_rooms/${roomId}/status`);
        onValue(statusRef, (snapshot) => {
            const status = snapshot.val();
            if (status === 'BUILDING' && (this.gameState === 'WAITING' || this.gameState === 'VOTING' || this.gameState === 'REVEALING')) {
                this.onBuildStarted();
            } else if (status === 'SPECTATING' && this.gameState === 'BUILDING') {
                this.onSpectateStarted();
            } else if (status === 'VOTING' && this.gameState === 'SPECTATING') {
                this.onVotingStarted();
            } else if (status === 'REVEALING') {
                this.onRevealingStarted();
            } else if (status === 'ENDED') {
                this.onGameEnded();
            }
        });

        const readyBtn = document.getElementById('imposter-ready-btn');
        if (readyBtn) readyBtn.onclick = () => {
            set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${roomId}/players/${this.game.playerId}/ready`), true);
            readyBtn.innerText = "WAITING FOR OTHERS...";
            readyBtn.disabled = true;
        };

        const leaveBtn = document.getElementById('imposter-leave-btn');
        if (leaveBtn) leaveBtn.onclick = () => {
            off(playersRef);
            off(statusRef);
            remove(ref(db, `rooms/${this.worldCode}/imposter_rooms/${roomId}/players/${this.game.playerId}`));
            this.roomId = null;
            if (readyBtn) {
                readyBtn.innerText = "I'M READY!";
                readyBtn.disabled = false;
            }
            this.game.showScreen('imposter-lobby');
        };
    }

    renderReadyList(players) {
        const list = document.getElementById('imposter-ready-list');
        if (!list) return;
        list.innerHTML = '';
        Object.values(players).forEach(p => {
            const div = document.createElement('div');
            div.className = 'ready-item';
            div.innerHTML = `
                <span>👤 ${p.name}</span>
                <span class="status-badge ${p.ready ? 'ready' : ''}">${p.ready ? 'READY' : 'NOT READY'}</span>
            `;
            list.appendChild(div);
        });
    }

    // ─── FACILITATOR DASHBOARD ────────────────────────────────────────────────
    setupFacilitatorDashboard() {
        this.worldCode = this.game.worldCode || "";
        const worldCode = this.worldCode;
        this.game.landingScreen.classList.remove('hidden');
        this.game.showScreen('imposter-facilitator-dashboard');

        // Setup live rooms list
        const roomsRef = ref(db, `rooms/${worldCode}/imposter_rooms`);
        onValue(roomsRef, (snapshot) => {
            const grid = document.getElementById('imposter-fac-room-list');
            if (!grid) return;
            const rooms = snapshot.val() || {};
            grid.innerHTML = '';

            const activeRooms = Object.values(rooms).filter(r => r.players && Object.keys(r.players).length > 0);
            
            if (activeRooms.length === 0) {
                grid.innerHTML = `<div style="text-align: center; color: #aaa; margin-top: 50px;"><p>No players in any rooms.</p></div>`;
                return;
            }

            activeRooms.forEach(room => {
                const count = Object.keys(room.players).length;
                const activeCount = Object.values(room.players).filter(p => !p.eliminated).length;
                
                const card = document.createElement('div');
                card.className = 'fac-room-card';
                card.innerHTML = `
                    <div style="font-weight:bold; font-size:1.1rem; color:#333;">${room.name}</div>
                    <div style="color:#666; font-size:0.9rem; margin-bottom: 8px;">👥 ${activeCount} Active / ${count} Total</div>
                    <div class="status-badge ${room.status !== 'WAITING' ? 'ready' : ''}" style="margin-bottom:10px; display:inline-block;">${room.status}</div>
                    <button class="secondary-btn" style="width:100%; font-size:0.8rem; padding: 6px;">Spectate Live</button>
                `;
                card.querySelector('button').onclick = () => this.spectateRoom(room.id);
                grid.appendChild(card);
            });

            // Fast forward detection
            let canFastForward = false;
            activeRooms.forEach(r => {
                if (r.status === 'BUILDING' || r.status === 'SPECTATING' || r.status === 'REVEALING') canFastForward = true;
            });

            const startBtn = document.getElementById('imposter-fac-start');
            if (startBtn) {
                if (canFastForward) {
                    startBtn.innerText = "Fast Forward Phase ⏭️";
                    startBtn.style.backgroundColor = "#ff9800"; // Orange
                } else {
                    startBtn.innerText = "Start Round";
                    startBtn.style.backgroundColor = "";
                }
            }
        });

        // Bind exit
        document.getElementById('imposter-fac-exit').onclick = () => {
            window.location.reload();
        };

        // Start Round
        const startBtn = document.getElementById('imposter-fac-start');
        startBtn.onclick = async () => {
            const majInput = document.getElementById('imposter-word-majority').value.trim();
            const impInput = document.getElementById('imposter-word-imposter').value.trim();
            
            const bTimeStr = document.getElementById('imposter-fac-build-time').value;
            const bTime = parseInt(bTimeStr) || DEFAULT_BUILD_DURATION;
            
            const sTimeStr = document.getElementById('imposter-fac-spectate-time').value;
            const sTime = parseInt(sTimeStr) || DEFAULT_SPECTATE_DURATION;

            const snapshot = await get(ref(db, `rooms/${worldCode}/imposter_rooms`));
            const rooms = snapshot.val();
            if (rooms) {
                // First, check if we're doing a fast-forward
                let isFastForwarding = false;
                Object.values(rooms).forEach(room => {
                    if (room.players && Object.keys(room.players).length > 0) {
                        if (room.status === 'BUILDING') {
                            isFastForwarding = true;
                            set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/status`), 'SPECTATING');
                        } else if (room.status === 'SPECTATING') {
                            isFastForwarding = true;
                            set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/status`), 'VOTING');
                        } else if (room.status === 'REVEALING') {
                            isFastForwarding = true;
                            // Force transition logic
                            const aliveList = room.players ? Object.values(room.players).filter(p => !p.eliminated) : [];
                            const impId = room.imposterId;
                            const impAlive = aliveList.some(p => p.id === impId);
                            const crewAliveCount = aliveList.filter(p => p.id !== impId).length;

                            if (!impAlive || crewAliveCount <= 1) {
                                set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/status`), 'ENDED');
                            } else {
                                Object.keys(room.players).forEach(pid => {
                                    set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/players/${pid}/voteFor`), null);
                                });
                                set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/startedAt`), Date.now());
                                set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/status`), 'BUILDING');
                            }
                        }
                    }
                });

                if (isFastForwarding) return; // Ignore start logic if we fast-forwarded

                // Otherwise, start the game normally for WAITING rooms
                Object.values(rooms).forEach(room => {
                    if (room.players && Object.keys(room.players).length > 0) {
                        
                        let majW = majInput;
                        let impW = impInput;

                        if (!majW || !impW) {
                            const pair = DEFAULT_IMPOSTER_PAIRS[Math.floor(Math.random() * DEFAULT_IMPOSTER_PAIRS.length)];
                            majW = pair.majority;
                            impW = pair.imposter;
                        }

                        // Pick imposter
                        const pList = Object.values(room.players);
                        // Only pick imposter among those not already eliminated (if it's a new game, nobody is eliminated yet)
                        const activeP = pList.filter(p => !p.eliminated);
                        if(activeP.length > 0) {
                            const imposter = activeP[Math.floor(Math.random() * activeP.length)];
                            
                            pList.forEach(p => {
                                // Assign words
                                if (p.id === imposter.id) {
                                    set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/players/${p.id}/word`), impW);
                                    set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/imposterId`), p.id);
                                } else {
                                    set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/players/${p.id}/word`), majW);
                                }
                                // Reset votes
                                set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/players/${p.id}/voteFor`), null);
                            });
                        }

                        // Update room config
                        set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/buildDuration`), bTime);
                        set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/spectateDuration`), sTime);
                        set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/startedAt`), Date.now());
                        set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/status`), 'BUILDING');
                    }
                });
            }
        };

        // End Game
        const resetBtn = document.getElementById('imposter-fac-reset');
        if (resetBtn) {
            resetBtn.onclick = async () => {
                if (!confirm('End the game? This will send ALL players back to the lobby.')) return;
                const snapshot = await get(ref(db, `rooms/${worldCode}/imposter_rooms`));
                const rooms = snapshot.val();
                if (rooms) {
                    Object.values(rooms).forEach(room => {
                        set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/status`), 'ENDED');
                    });

                    setTimeout(async () => {
                        const snap2 = await get(ref(db, `rooms/${worldCode}/imposter_rooms`));
                        const rooms2 = snap2.val();
                        if (rooms2) {
                            Object.values(rooms2).forEach(room => {
                                set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/status`), 'WAITING');
                                if (room.players) {
                                    Object.keys(room.players).forEach(pid => {
                                        set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/players/${pid}/eliminated`), null);
                                        set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/players/${pid}/word`), null);
                                    });
                                }
                                set(ref(db, `rooms/${worldCode}/imposter_rooms/${room.id}/imposterId`), null);
                            });
                        }
                    }, 2000);
                }
            };
        }
    }

    spectateRoom(roomId) {
        this.worldCode = this.game.worldCode || "";
        this.roomId = roomId;
        this.isEliminated = true; // Facilitators act like eliminated spectators
        
        // Enter room
        const roomCode = `${this.worldCode}_imposter_${this.roomId}`;
        this.game.landingScreen.classList.add('hidden');
        this.game.uiContainer.classList.remove('hidden');
        this.game.enterRoom(roomCode);

        // Load all players' zone visuals
        get(ref(db, `rooms/${this.worldCode}/imposter_rooms/${roomId}/players`)).then(snap => {
            const players = snap.val();
            if (players) {
                const sorted = Object.values(players).sort((a, b) => a.id.localeCompare(b.id));
                this.createAllZoneVisuals(sorted);
                this.expandFloorForZones(sorted.length);
            }
        });

        document.getElementById('fac-spectate-back').classList.remove('hidden');

        // Setup the back button
        const backBtn = document.getElementById('fac-spectate-back');
        if (backBtn) {
            backBtn.onclick = () => {
                if (this.timerInterval) clearInterval(this.timerInterval);
                this.game.landingScreen.classList.remove('hidden');
                this.game.uiContainer.classList.add('hidden');
                backBtn.classList.add('hidden');
                
                // Clear bricks locally
                if (this.game.bricksRef) off(this.game.bricksRef);
                this.game.bricks.forEach(b => this.game.scene.remove(b));
                this.game.bricks = [];
                this.cleanupZoneVisuals();
                this.hideBuildHUD();

                // Return to dashboard
                this.game.showScreen('imposter-facilitator-dashboard');
            };
        }

        // Lock controls and show basic info
        this.gameState = 'SPECTATING';
        this.lockBuildingControls();
        this.showBuildHUD();
        this.updateHUDText("Spectate Live", `Room: ${roomId}`);
        
        setTimeout(() => this.zoomOutToAll(), 500); // give time for bricks to load
        this.forceRendererResize();
    }

    // ─── BUILD PHASE ──────────────────────────────────────────────────────────
    async onBuildStarted() {
        this.gameState = 'BUILDING';

        // Hide any open voting/revelation modals
        const votingModal = document.getElementById('imposter-voting-modal');
        if (votingModal) votingModal.classList.add('hidden');

        const instructionModal = document.getElementById('instruction-modal');
        if (instructionModal) instructionModal.classList.add('hidden');
        
        const modalOverlay = document.querySelector('.modal-overlay:not(.hidden)');
        if (modalOverlay) modalOverlay.classList.add('hidden');

        const roomSnap = await get(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}`));
        const roomData = roomSnap.val();
        
        const players = roomData.players ? Object.values(roomData.players).sort((a, b) => a.id.localeCompare(b.id)) : [];
        const myData = players.find(p => p.id === this.game.playerId);
        
        if (myData) {
            this.myWord = myData.word;
            this.isEliminated = !!myData.eliminated;
        }

        const myIndex = players.findIndex(p => p.id === this.game.playerId);
        this.zoneIndex = myIndex >= 0 ? myIndex : 0;
        this.zoneOrigin.set(this.zoneIndex * ZONE_SPACING, 0, 0);

        // Enter building room (only if not already in it, e.g. from previous round)
        const roomCode = `${this.worldCode}_imposter_${this.roomId}`;
        if (this.game.roomCode !== roomCode) {
            this.game.landingScreen.classList.add('hidden');
            this.game.uiContainer.classList.remove('hidden');
            this.game.enterRoom(roomCode);
        }

        this.expandFloorForZones(players.length);
        this.forceRendererResize();

        // Create visuals again just in case
        this.createAllZoneVisuals(players);

        if (this.isEliminated || this.game.isFacilitator) {
            // Already eliminated players shouldn't be building
            this.onSpectateStarted();
            return;
        }

        // Center camera on zone
        this.game.controls.target.set(this.zoneOrigin.x, 0, this.zoneOrigin.z);
        this.game.camera.position.set(this.zoneOrigin.x + 500, 500, this.zoneOrigin.z + 500);
        this.game.camera.lookAt(this.zoneOrigin.x, 0, this.zoneOrigin.z);
        this.game.controls.update();

        // Restore tools
        this.unlockBuildingControls();

        this.showBuildHUD();
        this.game.showModal('Imposter Builder', `Your word is: \n\n**${this.myWord}**\n\nBuild to show you know the word!`, '🎭');

        const duration = roomData.buildDuration || DEFAULT_BUILD_DURATION;
        this.startTimer(duration, () => this.endBuildPhase());
    }

    createAllZoneVisuals(players) {
        this.cleanupZoneVisuals();

        players.forEach((p, idx) => {
            const originX = idx * ZONE_SPACING;
            
            // Highlight your zone
            const color = p.id === this.game.playerId ? 0x8bc34a : 0x1cb0f6;

            const isDead = p.eliminated;
            const displayColor = isDead ? 0x555555 : color;

            const planeGeom = new THREE.PlaneGeometry(ZONE_SIZE, ZONE_SIZE);
            planeGeom.rotateX(-Math.PI / 2);
            const planeMat = new THREE.MeshBasicMaterial({
                color: displayColor,
                transparent: true,
                opacity: 0.12,
                side: THREE.DoubleSide
            });
            const plane = new THREE.Mesh(planeGeom, planeMat);
            plane.position.set(originX, 0.01, 0);
            plane.userData.isZoneVisual = true;
            this.game.scene.add(plane);
            this.zonePlanes.push(plane);

            const borderGeom = new THREE.EdgesGeometry(new THREE.PlaneGeometry(ZONE_SIZE, ZONE_SIZE));
            const borderMat = new THREE.LineBasicMaterial({ color: displayColor, transparent: true, opacity: 0.5 });
            const border = new THREE.LineSegments(borderGeom, borderMat);
            border.rotation.x = -Math.PI / 2;
            border.position.set(originX, 0.02, 0);
            border.userData.isZoneVisual = true;
            this.game.scene.add(border);
            this.zonePlanes.push(border);

            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = isDead ? '#555555' : `#${displayColor.toString(16).padStart(6, '0')}`;
            ctx.fillRect(0, 0, 512, 64);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 36px Nunito, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            let displayName = p.id === this.game.playerId ? `${p.name} (You)` : p.name;
            if (isDead) displayName += ' 💀';
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

    expandFloorForZones(playerCount) {
        const totalSpan = Math.max(playerCount, 1) * ZONE_SPACING;
        const neededSize = totalSpan + 800;
        const centerX = ((playerCount - 1) * ZONE_SPACING) / 2;

        if (this.game.floor) this.game.scene.remove(this.game.floor);
        const floorGeom = new THREE.PlaneGeometry(neededSize, neededSize);
        floorGeom.rotateX(-Math.PI / 2);
        this.game.floor = new THREE.Mesh(floorGeom, new THREE.MeshBasicMaterial({ visible: false }));
        this.game.floor.position.set(centerX, 0, 0);
        this.game.scene.add(this.game.floor);

        if (this.game.grid) this.game.scene.remove(this.game.grid);
        const gridSize = Math.ceil(neededSize / 2) * 2;
        this.game.grid = new THREE.GridHelper(gridSize, gridSize, 0x000000, 0x000000);
        this.game.grid.material.opacity = 0.1;
        this.game.grid.material.transparent = true;
        this.game.grid.position.set(centerX, 0, 0);
        this.game.scene.add(this.game.grid);
    }

    forceRendererResize() {
        const doResize = () => {
            if (this.game && typeof this.game.onWindowResize === 'function') {
                this.game.onWindowResize();
            }
        };
        setTimeout(doResize, 50);
        setTimeout(doResize, 200);
        setTimeout(doResize, 500);
    }

    showBuildHUD() {
        const hud = document.getElementById('imposter-build-hud');
        if (hud) {
            hud.classList.remove('hidden');
            document.getElementById('imposter-prompt-display').innerText = this.myWord;
            document.getElementById('imposter-subtext-display').innerText = "Build to prove you're not the imposter!";
        }
    }

    updateHUDText(main, sub) {
        const d = document.getElementById('imposter-prompt-display');
        const s = document.getElementById('imposter-subtext-display');
        if (d) d.innerText = main;
        if (s) s.innerText = sub;
    }

    hideBuildHUD() {
        const hud = document.getElementById('imposter-build-hud');
        if (hud) hud.classList.add('hidden');
    }

    isInMyZone(position) {
        if (this.gameState !== 'BUILDING') return false;
        if (this.isEliminated || this.game.isFacilitator) return false;
        
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

    startTimer(seconds, callback) {
        if (this.timerInterval) clearInterval(this.timerInterval);
        const endTime = Date.now() + seconds * 1000;
        const timerEl = document.getElementById('imposter-timer-text');
        const fillEl = document.getElementById('imposter-timer-fill');

        this.timerInterval = setInterval(() => {
            const timeLeft = Math.max(0, Math.round((endTime - Date.now()) / 1000));
            const m = Math.floor(timeLeft / 60);
            const s = timeLeft % 60;
            if (timerEl) timerEl.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            if (fillEl) fillEl.style.width = (timeLeft / seconds * 100) + '%';

            if (timeLeft <= 0) {
                clearInterval(this.timerInterval);
                if (callback && !this.game.isFacilitator && !this.isEliminated) {
                    callback();
                }
            }
        }, 1000);
    }

    endBuildPhase() {
        // Player 0 or lowest ID active triggers transitions
        get(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/players`)).then(snap => {
            const p = snap.val();
            if(p) {
                const actives = Object.values(p).filter(x => !x.eliminated).sort((a,b)=>a.id.localeCompare(b.id));
                if(actives.length > 0 && actives[0].id === this.game.playerId) {
                    set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/status`), 'SPECTATING');
                }
            }
        });
    }

    // ─── SPECTATE PHASE ───────────────────────────────────────────────────────
    async onSpectateStarted() {
        this.gameState = 'SPECTATING';
        if (this.timerInterval) clearInterval(this.timerInterval);

        this.lockBuildingControls();
        this.showBuildHUD();
        this.updateHUDText("Spectate & Discuss", "Look at everyone's builds. Who is the imposter?");

        this.zoomOutToAll();
        this.forceRendererResize();

        if (this.isEliminated || this.game.isFacilitator) return;

        const roomSnap = await get(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}`));
        const roomData = roomSnap.val();
        const duration = roomData.spectateDuration || DEFAULT_SPECTATE_DURATION;
        
        this.startTimer(duration, () => this.endSpectatePhase());
    }

    endSpectatePhase() {
        get(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/players`)).then(snap => {
            const p = snap.val();
            if(p) {
                const actives = Object.values(p).filter(x => !x.eliminated).sort((a,b)=>a.id.localeCompare(b.id));
                if(actives.length > 0 && actives[0].id === this.game.playerId) {
                    set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/status`), 'VOTING');
                }
            }
        });
    }

    // ─── VOTING PHASE ─────────────────────────────────────────────────────────
    async onVotingStarted() {
        this.gameState = 'VOTING';
        if (this.timerInterval) clearInterval(this.timerInterval);
        
        this.lockBuildingControls();
        this.hideBuildHUD();

        const roomSnap = await get(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}`));
        const roomData = roomSnap.val();
        const players = Object.values(roomData.players || {});
        
        const modal = document.getElementById('imposter-voting-modal');
        const optionsGrid = document.getElementById('imposter-voting-options');
        const statusEl = document.getElementById('imposter-voting-status');
        
        if (modal) modal.classList.remove('hidden');
        if (optionsGrid) {
            optionsGrid.innerHTML = '';
            
            const activePlayers = players.filter(p => !p.eliminated);
            
            // Check win scenarios early just in case
            if (activePlayers.length <= 2) {
                // Imposter win logic handled by Resolution, but just in case
            }

            activePlayers.forEach(p => {
                const btn = document.createElement('button');
                btn.className = 'secondary-btn';
                btn.style.width = '100%';
                btn.style.padding = '15px';
                btn.innerText = `Vote for ${p.name}`;
                
                if (this.isEliminated || this.game.isFacilitator) {
                    btn.disabled = true;
                    btn.style.opacity = '0.5';
                } else {
                    btn.onclick = () => {
                        // Cast vote
                        set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/players/${this.game.playerId}/voteFor`), p.id);
                        
                        // Disable all buttons after voting
                        Array.from(optionsGrid.querySelectorAll('button')).forEach(b => {
                            b.disabled = true;
                            b.style.opacity = '0.5';
                        });
                        btn.style.opacity = '1';
                        btn.style.borderColor = '#1cb0f6';
                        btn.innerText = `Voted for ${p.name}`;
                    };
                }
                optionsGrid.appendChild(btn);
            });
        }
        
        if (statusEl && (this.isEliminated || this.game.isFacilitator)) {
            statusEl.innerText = "Watching the live vote...";
        }

        // Listen for all votes to be cast
        const playersRef = ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/players`);
        this.voteListener = onValue(playersRef, (snap) => {
            const data = snap.val();
            if (data && this.gameState === 'VOTING') {
                const activesList = Object.values(data).filter(p => !p.eliminated);
                const voteCount = activesList.filter(p => p.voteFor).length;
                
                if (statusEl) {
                    statusEl.innerText = `${voteCount}/${activesList.length} votes cast...`;
                }

                if (voteCount === activesList.length) {
                    // Everyone voted
                    off(playersRef, this.voteListener);
                    // Master client processes elimination
                    if (activesList.length > 0 && activesList.sort((a,b)=>a.id.localeCompare(b.id))[0].id === this.game.playerId) {
                        this.processVotes(activesList, data, roomData.imposterId);
                    }
                }
            }
        });
    }

    processVotes(actives, allPlayers, imposterId) {
        // Tally votes
        const tallies = {};
        actives.forEach(p => {
            if (p.voteFor) tallies[p.voteFor] = (tallies[p.voteFor] || 0) + 1;
        });

        // Find max votes
        let maxVotes = -1;
        let eliminatedId = null;
        Object.keys(tallies).forEach(pid => {
            if (tallies[pid] > maxVotes) {
                maxVotes = tallies[pid];
                eliminatedId = pid;
            }
        });

        if (!eliminatedId && actives.length > 0) eliminatedId = actives[0].id; // Fallback

        const eliminatedPlayer = allPlayers[eliminatedId];
        const isImposter = eliminatedId === imposterId;

        // Mark player as eliminated
        set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/players/${eliminatedId}/eliminated`), true);

        // Store result for revealing
        set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/lastEliminated`), {
            name: eliminatedPlayer ? eliminatedPlayer.name : "Someone",
            role: isImposter ? "Imposter" : "Innocent"
        });

        // Transition to REVEALING
        set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/status`), 'REVEALING');
    }

    async onRevealingStarted() {
        this.gameState = 'REVEALING';
        if (this.timerInterval) clearInterval(this.timerInterval);

        // Hide voting modal
        const votingModal = document.getElementById('imposter-voting-modal');
        if (votingModal) votingModal.classList.add('hidden');

        const roomSnap = await get(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}`));
        const data = roomSnap.val();
        
        if (data && data.lastEliminated) {
            const { name, role } = data.lastEliminated;
            this.game.showModal('Round Result', `${name} has been eliminated!\n\nThey were... ${role}!`, role === 'Imposter' ? '💥' : '😇');
        }

        // Only master player handles the transition delay
        const actives = data.players ? Object.values(data.players).filter(p => !p.eliminated).sort((a,b)=>a.id.localeCompare(b.id)) : [];
        const isMaster = actives.length > 0 && actives[0].id === this.game.playerId;

        if (isMaster) {
            console.log("Master client detected. Transitioning state in 6s...");
            setTimeout(async () => {
                this.worldCode = this.game.worldCode || "";
                const refreshedSnap = await get(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}`));
                const rData = refreshedSnap.val();
                if (!rData) return;
                
                // Check win conditions
                const impId = rData.imposterId;
                const aliveList = Object.values(rData.players).filter(p => !p.eliminated);
                const impAlive = aliveList.some(p => p.id === impId);
                const crewAliveCount = aliveList.filter(p => p.id !== impId).length;

                console.log(`Revealing done. Imp alive: ${impAlive}, Crew alive count: ${crewAliveCount}`);

                if (!impAlive) {
                    set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/winner`), 'CREW');
                    set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/status`), 'ENDED');
                } else if (crewAliveCount <= 1) {
                    set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/winner`), 'IMPOSTER');
                    set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/status`), 'ENDED');
                } else {
                    // Reset all votes for next round
                    Object.keys(rData.players).forEach(pid => {
                        set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/players/${pid}/voteFor`), null);
                    });
                    set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/startedAt`), Date.now());
                    set(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}/status`), 'BUILDING');
                }
            }, 6000); // 6 second reveal
        }
    }

    // ─── END PHASE ────────────────────────────────────────────────────────────
    async onGameEnded() {
        this.gameState = 'WAITING';
        if (this.timerInterval) clearInterval(this.timerInterval);

        const votingModal = document.getElementById('imposter-voting-modal');
        if (votingModal) votingModal.classList.add('hidden');

        // Check winner
        try {
            const snap = await get(ref(db, `rooms/${this.worldCode}/imposter_rooms/${this.roomId}`));
            const data = snap.val();
            if (data && data.winner) {
                const winModal = document.getElementById('imposter-winner-modal');
                const winTitle = document.getElementById('imposter-winner-title');
                const winText = document.getElementById('imposter-winner-text');
                
                if (winModal) winModal.classList.remove('hidden');
                
                let impP = null;
                if(data.players && data.imposterId) impP = data.players[data.imposterId];

                if (data.winner === 'CREW') {
                    if (winTitle) winTitle.innerText = "Crew Wins!";
                    if (winText) winText.innerText = `The imposter was caught! It was ${impP ? impP.name : 'someone'}.`;
                } else if (data.winner === 'IMPOSTER') {
                    if (winTitle) { winTitle.innerText = "Imposter Wins!"; winTitle.style.color = '#ff4b4b'; }
                    if (winText) winText.innerText = `The imposter survived! It was ${impP ? impP.name : 'someone'}.`;
                }

                // Bind close
                const closeBtn = document.getElementById('imposter-winner-close-btn');
                if (closeBtn) {
                    closeBtn.onclick = () => {
                        winModal.classList.add('hidden');
                        this.returnToLobby();
                    };
                }
                return; // early return, let the user click the modal
            }
        } catch (e) {
            console.error(e);
        }

        // Hard reset (facilitator click)
        this.returnToLobby();
    }

    returnToLobby() {
        this.cleanupZoneVisuals();
        this.hideBuildHUD();

        if (this.game.bricksRef) off(this.game.bricksRef);
        this.game.bricks.forEach(b => this.game.scene.remove(b));
        this.game.bricks = [];

        this.game.landingScreen.classList.remove('hidden');
        this.game.uiContainer.classList.add('hidden');

        if (this.game.isFacilitator) {
            this.game.showScreen('imposter-facilitator-dashboard');
        } else {
            this.game.showScreen('imposter-lobby');
        }

        this.unlockBuildingControls();
    }

    // ─── UTILS ────────────────────────────────────────────────────────────────
    lockBuildingControls() {
        const sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.classList.add('hidden');

        ['undo-btn', 'clear-btn', 'export-btn', 'import-btn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.add('hidden');
        });

        if (this.game.ghostBrick) this.game.ghostBrick.visible = false;
        this.game.uiContainer.classList.add('sidebar-collapsed');
    }

    unlockBuildingControls() {
        const sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.classList.remove('hidden');

        ['undo-btn', 'clear-btn', 'export-btn', 'import-btn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.remove('hidden');
        });

        this.game.uiContainer.classList.remove('sidebar-collapsed');
    }

    zoomOutToAll() {
        const box = new THREE.Box3();
        this.game.bricks.forEach(b => box.expandByObject(b));
        this.zonePlanes.forEach(p => box.expandByObject(p));

        if (!box.isEmpty()) {
            const center = new THREE.Vector3();
            box.getCenter(center);
            this.game.controls.target.copy(center);
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.z, 200);
            this.game.camera.position.set(center.x + 500 + maxDim, 500 + maxDim, center.z + 500 + maxDim);
            this.game.camera.lookAt(center);
            this.game.controls.update();
        }
    }
}
