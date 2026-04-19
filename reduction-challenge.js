/**
 * Reduction Challenge Mode
 * ------------------------
 * 3 Rounds: Build, Rebuild (with fewer bricks), Rebuild (with even fewer bricks).
 * Round 1: 8 minutes
 * Round 2: 5 minutes, 75% of Round 1 brick count
 * Round 3: 3 minutes, 50% of Round 1 brick count
 */

import * as THREE from 'three';
import { db } from './firebase-config.js';
import { ref, onValue, set, push, remove, get, onDisconnect, off } from 'firebase/database';
import { createBrick, BRICK_TYPES } from './bricks.js';

// Removed DEFAULT_PROMPT as per user request

const ZONE_SIZE = 10;
const ZONE_SPACING = 14;

// Timers and brick limits
const TIMES = {
    round1: 480, // 8 mins
    round2: 300, // 5 mins
    round3: 180  // 3 mins
};

const MIN_BRICKS_R1 = 15; // To prevent the scale-down from being mathematically impossible/pointless

const ZONE_COLORS = [
    0xff4757, // red
    0x1cb0f6, // blue
    0x58cc02, // green
    0xff9f00, // amber
    0xa855f7, // purple
    0xff6b81, // pink
];

export class ReductionChallengeMode {
    constructor(game) {
        this.game = game;
        this.worldCode = null;
        this.roomId = null;
        this.currentRound = 'WAITING'; // WAITING | ROUND_1 | REVIEW_1 | ROUND_2 | REVIEW_2 | ROUND_3 | REVIEW_3 | ENDED
        this.maxBricks = { round2: 0, round3: 0 };
        this.myBrickCounts = { round1: 0, round2: 0, round3: 0 };
        
        this.zoneIndex = -1;
        this.zoneOrigin = new THREE.Vector3();
        this.zonePlanes = [];
        this.zoneLabels = [];
        
        this.timerInterval = null;
        
        this._lobbyInitialized = false;
        this._facInitialized = false;
        this._roomListeners = [];
    }

    // ─── LOBBY ────────────────────────────────────────────────────────────
    setupLobby(worldCode) {
        this.worldCode = worldCode;
        if (this._lobbyInitialized) return;
        this._lobbyInitialized = true;

        const lobbyCodeEl = document.getElementById('reduction-lobby-code');
        if (lobbyCodeEl) lobbyCodeEl.querySelector('span').innerText = worldCode;

        const lobbyPlayerDisplay = document.getElementById('reduction-lobby-player-display');
        if (lobbyPlayerDisplay) {
            const displayName = this.game.playerName || `Builder ${this.game.playerId.substring(2, 7).toUpperCase()}`;
            lobbyPlayerDisplay.querySelector('span').innerText = displayName;
        }

        const createBtn = document.getElementById('create-reduction-room-btn');
        const roomsRef = db ? ref(db, `rooms/${worldCode}/reduction_rooms`) : null;

        if (roomsRef) this.seedDefaultRooms(worldCode);

        createBtn.onclick = () => {
            if (!db) { alert('Firebase is not connected.'); return; }
            const name = prompt('Enter Room Name:', 'Alpha Team');
            if (name) {
                const newRef = push(roomsRef);
                set(newRef, { id: newRef.key, name, status: 'WAITING', round: 'WAITING', players: {} });
            }
        };

        if (roomsRef) {
            onValue(roomsRef, (snapshot) => {
                const rooms = snapshot.val();
                const grid = document.getElementById('reduction-room-grid');
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
            { id: 'red_room',    name: 'Red Room'    },
            { id: 'green_room',  name: 'Green Room'  },
            { id: 'blue_room',   name: 'Blue Room'   },
            { id: 'yellow_room', name: 'Yellow Room'  }
        ];
        for (const room of defaults) {
            const r = ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}`);
            try {
                const snap = await get(r);
                if (!snap.exists()) {
                    await set(r, { id: room.id, name: room.name, status: 'WAITING', round: 'WAITING', players: {} });
                }
            } catch (e) { console.error('Seed error:', e); }
        }
    }

    // ─── ROOM LOBBY ───────────────────────────────────────────────────────
    enterRoom(roomId) {
        this.roomId = roomId;
        this.game.showScreen('reduction-room');
        document.getElementById('reduction-room-title').innerText = 'Room: ' + roomId.substring(0, 8);

        const readyBtn = document.getElementById('reduction-ready-btn');
        let isReady = false;
        readyBtn.onclick = () => {
            isReady = !isReady;
            set(ref(db, `rooms/${this.worldCode}/reduction_rooms/${roomId}/players/${this.game.playerId}/ready`), isReady);
            readyBtn.innerText = isReady ? 'CANCEL READY' : "I'M READY!";
            readyBtn.classList.toggle('active', isReady);
        };

        const leaveBtn = document.getElementById('reduction-leave-btn');
        if (leaveBtn) {
            leaveBtn.onclick = () => {
                if (db) remove(ref(db, `rooms/${this.worldCode}/reduction_rooms/${roomId}/players/${this.game.playerId}`));
                this.game.showScreen('reduction-lobby');
            };
        }

        const displayName = this.game.playerName || `Builder ${this.game.playerId.substring(2, 7).toUpperCase()}`;
        const playerRef = ref(db, `rooms/${this.worldCode}/reduction_rooms/${roomId}/players/${this.game.playerId}`);
        set(playerRef, { id: this.game.playerId, name: displayName, ready: false });
        onDisconnect(playerRef).remove();

        // Listen for players
        const allPlayersRef = ref(db, `rooms/${this.worldCode}/reduction_rooms/${roomId}/players`);
        onValue(allPlayersRef, (snapshot) => {
            const players = snapshot.val();
            const listEl = document.getElementById('reduction-ready-list');
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
                const countEl = document.getElementById('reduction-player-count');
                if (countEl) countEl.innerText = `${arr.length}/6 Players`;
            }
        });

        // Listen for round state changes
        const roundRef = ref(db, `rooms/${this.worldCode}/reduction_rooms/${roomId}/round`);
        onValue(roundRef, (snapshot) => {
            const round = snapshot.val();
            if (round && round !== 'WAITING' && round !== this.currentRound) {
                this.handleRoundChange(round);
            }
        });
    }

    onPlayersUpdated(players) {
        if (!players) return;
        const arr = Object.values(players).sort((a, b) => a.id.localeCompare(b.id));
        
        // Update my zone index in case it changed (usually it shouldn't, but for safety)
        const myIndex = arr.findIndex(p => p.id === this.game.playerId);
        if (myIndex >= 0) {
            this.zoneIndex = myIndex;
            this.zoneOrigin.set(this.zoneIndex * ZONE_SPACING, 0, 0);
        }

        // Refresh visuals
        if (arr.length > 0) {
            this.expandFloorForZones(arr.length);
            this.createAllZoneVisuals(arr);
        }
    }

    // ─── FACILITATOR DASHBOARD ────────────────────────────────────────────
    setupFacilitatorDashboard(worldCode) {
        this.worldCode = worldCode;
        if (this._facInitialized) return;
        this._facInitialized = true;

        const startBtn = document.getElementById('reduction-fac-start');
        const skipBtn = document.getElementById('reduction-fac-skip');
        const nextBtn = document.getElementById('reduction-fac-next');
        const galleryBtn = document.getElementById('reduction-fac-gallery');
        const exitBtn = document.getElementById('reduction-fac-exit');
        const resetBtn = document.getElementById('reduction-fac-reset');

        // Fixed navigation: ensure facilitator returns to dashboard correctly
        const backBtn = document.getElementById('fac-spectate-back');
        if (backBtn) {
            backBtn.onclick = () => {
                backBtn.classList.add('hidden');
                document.getElementById('reduction-fac-dashboard').classList.remove('hidden');
                this.game.enterRoom(this.worldCode);
            };
        }

        startBtn.onclick = async () => {
            if (!confirm(`Start Round 1?`)) return;

            const snapshot = await get(ref(db, `rooms/${worldCode}/reduction_rooms`));
            const rooms = snapshot.val();
            if (rooms) {
                const now = Date.now();
                const duration = TIMES.round1 * 1000;
                Object.values(rooms).forEach(room => {
                    if (room.status === 'WAITING' || room.round === 'WAITING') {
                        set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/round`), 'ROUND_1');
                        set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/startedAt`), now);
                        set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/endTime`), now + duration);
                    }
                });
            }
            
            // UI switch
            startBtn.style.display = 'none';
            skipBtn.style.display = 'block';
        };

        skipBtn.onclick = async () => {
            if (!confirm(`End the current timer early and go to the review phase?`)) return;
            const snapshot = await get(ref(db, `rooms/${worldCode}/reduction_rooms`));
            const rooms = snapshot.val();
            if (rooms) {
                Object.values(rooms).forEach(room => {
                    if (room.round === 'ROUND_1') set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/round`), 'REVIEW_1');
                    if (room.round === 'ROUND_2') set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/round`), 'REVIEW_2');
                    if (room.round === 'ROUND_3') set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/round`), 'REVIEW_3');
                    // Clear timer
                    set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/endTime`), null);
                });
            }
        };

        nextBtn.onclick = async () => {
            const snapshot = await get(ref(db, `rooms/${worldCode}/reduction_rooms`));
            const rooms = snapshot.val();
            let nextRoundTarget = null;
            let duration = 0;

            if (rooms) {
                const firstRoom = Object.values(rooms)[0];
                if (firstRoom.round === 'REVIEW_1') { nextRoundTarget = 'ROUND_2'; duration = TIMES.round2 * 1000; }
                else if (firstRoom.round === 'REVIEW_2') { nextRoundTarget = 'ROUND_3'; duration = TIMES.round3 * 1000; }
                else if (firstRoom.round === 'REVIEW_3') { nextRoundTarget = 'ENDED'; }

                if (!nextRoundTarget) return;

                if (!confirm(`Start ${nextRoundTarget}?`)) return;

                const now = Date.now();
                Object.values(rooms).forEach(room => {
                    if (room.round.startsWith('REVIEW_')) {
                        set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/round`), nextRoundTarget);
                        set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/startedAt`), now);
                        if (duration > 0) set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/endTime`), now + duration);
                    }
                });
            }
        };

        resetBtn.onclick = async () => {
            if (!confirm('End the game immediately and clear all builds?')) return;
            const snapshot = await get(ref(db, `rooms/${worldCode}/reduction_rooms`));
            const rooms = snapshot.val();
            if (rooms) {
                Object.values(rooms).forEach(room => {
                    set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/round`), 'ENDED');
                    // short delay then to WAITING to clear it
                    setTimeout(() => {
                        set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/round`), 'WAITING');
                        set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/bricks_round_1`), null);
                        set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/bricks_round_2`), null);
                        set(ref(db, `rooms/${worldCode}/reduction_rooms/${room.id}/bricks_round_3`), null);
                    }, 2000);
                });
            }
            startBtn.style.display = 'block';
            skipBtn.style.display = 'none';
            nextBtn.style.display = 'none';
            galleryBtn.style.display = 'none';
        };

        exitBtn.onclick = () => {
            if (confirm('Exit Mission Control?')) window.location.reload();
        };

        // Watch overall state to update facilitator buttons
        const roomsRef = db ? ref(db, `rooms/${worldCode}/reduction_rooms`) : null;
        if (roomsRef) {
            onValue(roomsRef, (snapshot) => {
                const rooms = snapshot.val();
                const listEl = document.getElementById('reduction-fac-room-list');
                listEl.innerHTML = '';
                
                let anyReview = false;
                let anyBuild = false;
                let anyEnded = false;

                if (rooms) {
                    Object.values(rooms).forEach(room => {
                        if (room.round.startsWith('REVIEW_')) anyReview = true;
                        if (room.round.startsWith('ROUND_')) anyBuild = true;
                        if (room.round === 'ENDED') anyEnded = true;

                        const card = document.createElement('div');
                        card.className = 'fac-room-card-premium';
                        const players = room.players ? Object.values(room.players) : [];
                        const playerNames = players.map(p => p.name).join(', ') || 'No players yet';

                        let statusClass = room.round.startsWith('ROUND_') ? 'status-build' : (room.round.startsWith('REVIEW_') ? 'status-complete' : 'status-waiting');
                        if (room.round === 'ENDED') statusClass = 'status-complete';

                        card.innerHTML = `
                            <div class="room-status-dot ${statusClass}"></div>
                            <div class="fac-room-info">
                                <h4>${room.name}</h4>
                                <p>Phase: <span style="font-weight:700; color: ${statusClass === 'status-build' ? '#1cb0f6' : '#666'}">${room.round}</span></p>
                                <p style="font-size: 0.75rem; color: #888; margin-top: 5px;">👤 ${playerNames}</p>
                            </div>
                            <div class="fac-room-players">${players.length}/6 Players</div>
                        `;
                        card.onclick = () => this.spectateRoom(room.id, room);
                        listEl.appendChild(card);
                    });
                } else {
                    listEl.innerHTML = '<div style="text-align: center; color: #aaa; margin-top: 50px;"><p>No rooms detected.</p></div>';
                }

                if (anyEnded) {
                    skipBtn.style.display = 'none';
                    nextBtn.style.display = 'none';
                    startBtn.style.display = 'none';
                    galleryBtn.style.display = 'block';
                    galleryBtn.onclick = () => this.openGalleryView();
                } else if (anyReview) {
                    skipBtn.style.display = 'none';
                    nextBtn.style.display = 'block';
                    startBtn.style.display = 'none';
                    galleryBtn.style.display = 'none';
                } else if (anyBuild) {
                    skipBtn.style.display = 'block';
                    nextBtn.style.display = 'none';
                    startBtn.style.display = 'none';
                    galleryBtn.style.display = 'none';
                }
            });
        }
        
    }

    spectateRoom(roomId, roomData) {
        if (roomData.round === 'WAITING' || roomData.round === 'ENDED') {
            alert("This room is either waiting to start or has ended.");
            return;
        }

        const world = this.worldCode;
        
        // Find which round bucket to watch
        let bucket = 'bricks_round_1';
        if (roomData.round.includes('2')) bucket = 'bricks_round_2';
        if (roomData.round.includes('3')) bucket = 'bricks_round_3';

        this.game.firebasePathBase = `rooms/${world}/reduction_rooms/${roomId}/${bucket}`;
        const displayCode = `${world}_reduction_${roomId}_${bucket}`;
        this.game.enterRoom(displayCode);

        // Load all players' zone visuals
        get(ref(db, `rooms/${world}/reduction_rooms/${roomId}/players`)).then(snap => {
            const players = snap.val();
            if (players) {
                const sorted = Object.values(players).sort((a, b) => a.id.localeCompare(b.id));
                this.createAllZoneVisuals(sorted);
                this.expandFloorForZones(sorted.length);
            }
        });

        document.getElementById('fac-spectate-back').classList.remove('hidden');
        this.forceRendererResize();
    }

    async openGalleryView() {
        const modal = document.getElementById('reduction-gallery-modal');
        const grid = document.getElementById('reduction-gallery-grid');
        grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center;">Loading all builds...</div>';
        modal.classList.remove('hidden');

        document.getElementById('reduction-gallery-close').onclick = () => {
            modal.classList.add('hidden');
        };

        const snapshot = await get(ref(db, `rooms/${this.worldCode}/reduction_rooms`));
        const rooms = snapshot.val();
        if (!rooms) {
            grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center;">No data found.</div>';
            return;
        }

        grid.innerHTML = '';
        
        Object.values(rooms).forEach(room => {
            if (!room.players) return;
            Object.values(room.players).forEach(player => {
                const card = document.createElement('div');
                card.className = 'fac-room-card-premium';
                card.style.cursor = 'pointer';
                card.innerHTML = `
                    <div class="room-status-dot status-complete"></div>
                    <div class="fac-room-info">
                        <h4>${player.name}</h4>
                        <p style="font-size: 0.75rem; color: #888;">${room.name}</p>
                    </div>
                    <div class="fac-room-players">View 3 Rounds →</div>
                `;
                card.onclick = () => this.openPlayerInGallery(room.id, player);
                grid.appendChild(card);
            });
        });
    }

    async openPlayerInGallery(roomId, player) {
        const modal = document.getElementById('reduction-player-modal');
        document.getElementById('reduction-player-name-title').innerText = `${player.name}'s Transformation`;
        modal.classList.remove('hidden');

        document.getElementById('reduction-player-close').onclick = () => {
            modal.classList.add('hidden');
            // Clean up mini renderers
            this.activeGalleryRenderers?.forEach(r => r.cleanup());
            this.activeGalleryRenderers = [];
        };

        const r1CountEl = document.getElementById('reduction-p-r1-count');
        const r2CountEl = document.getElementById('reduction-p-r2-count');
        const r3CountEl = document.getElementById('reduction-p-r3-count');
        r1CountEl.innerText = player.brickCount?.round1 || 0;
        r2CountEl.innerText = player.brickCount?.round2 || 0;
        r3CountEl.innerText = player.brickCount?.round3 || 0;

        // Fetch the 3 sets of bricks
        const r1Snap = await get(ref(db, `rooms/${this.worldCode}/reduction_rooms/${roomId}/bricks_round_1`));
        const r2Snap = await get(ref(db, `rooms/${this.worldCode}/reduction_rooms/${roomId}/bricks_round_2`));
        const r3Snap = await get(ref(db, `rooms/${this.worldCode}/reduction_rooms/${roomId}/bricks_round_3`));

        const getPlayerBricks = (snap) => {
            const data = snap.val();
            if (!data) return [];
            return Object.values(data).filter(b => b.playerId === player.id);
        };

        const r1Bricks = getPlayerBricks(r1Snap);
        const r2Bricks = getPlayerBricks(r2Snap);
        const r3Bricks = getPlayerBricks(r3Snap);

        // Render to canvas containers
        this.activeGalleryRenderers = [];
        this.activeGalleryRenderers.push(new GalleryMiniRenderer(document.getElementById('reduction-canvas-r1'), r1Bricks, this.game));
        this.activeGalleryRenderers.push(new GalleryMiniRenderer(document.getElementById('reduction-canvas-r2'), r2Bricks, this.game));
        this.activeGalleryRenderers.push(new GalleryMiniRenderer(document.getElementById('reduction-canvas-r3'), r3Bricks, this.game));
    }

    // ─── GAME STATE MACHINE ───────────────────────────────────────────────
    handleRoundChange(newRound) {
        this.currentRound = newRound;

        if (newRound === 'ROUND_1') this.startRound(1);
        if (newRound === 'ROUND_2') this.startRound(2);
        if (newRound === 'ROUND_3') this.startRound(3);

        if (newRound === 'REVIEW_1') this.startReviewPhase(1);
        if (newRound === 'REVIEW_2') this.startReviewPhase(2);
        if (newRound === 'REVIEW_3') this.startReviewPhase(3);

        if (newRound === 'ENDED') this.onGameEnded();
    }

    async startRound(roundNum) {
        // Fetch room data
        const roomSnap = await get(ref(db, `rooms/${this.worldCode}/reduction_rooms/${this.roomId}`));
        const roomData = roomSnap.val();

        if (roundNum === 1) {
            // First time joining the physical game world
            const players = roomData.players ? Object.values(roomData.players).sort((a, b) => a.id.localeCompare(b.id)) : [];
            const myIndex = players.findIndex(p => p.id === this.game.playerId);
            this.zoneIndex = myIndex >= 0 ? myIndex : 0;
            this.zoneOrigin.set(this.zoneIndex * ZONE_SPACING, 0, 0);

            // Connect to correct firebase paths
            this.game.firebasePathBase = `rooms/${this.worldCode}/reduction_rooms/${this.roomId}/bricks_round_1`;
            this.game.firebasePlayersPath = `rooms/${this.worldCode}/reduction_rooms/${this.roomId}/players`;
            
            this.game.landingScreen.classList.add('hidden');
            this.game.uiContainer.classList.remove('hidden');
            
            // Fix canvas size if it was hidden on start
            this.game.onWindowResize();
            this.forceRendererResize();

            this.game.listenToRoom();

            this.expandFloorForZones(players.length);
            this.createAllZoneVisuals(players);
            
            // Ensure grid/floor are actually in the scene and visible
if (this.game.floor) this.game.floor.visible = true;
            if (this.game.grid) this.game.grid.visible = true;

            // Set up limits map correctly for later rounds
            // (Wait, round 1 max is unlimited)
        } else {
            // Round 2 or 3: clear bricks from scene
            if (this.game.bricksRef) off(this.game.bricksRef);
            this.game.bricks.forEach(b => this.game.scene.remove(b));
            this.game.bricks = [];
            this.game.brickCount = 0;

            // Compute new limits if not already done by facilitator
            if (roundNum === 2) {
                // To keep it simple, we check my bricks from Round 1
                const r1Snap = await get(ref(db, `rooms/${this.worldCode}/reduction_rooms/${this.roomId}/players/${this.game.playerId}/brickCount/round1`));
                const r1Count = r1Snap.val() || MIN_BRICKS_R1;
                const newMax = Math.max(Math.floor(r1Count * 0.75), 1);
                this.maxBricks.round2 = newMax;
                set(ref(db, `rooms/${this.worldCode}/reduction_rooms/${this.roomId}/players/${this.game.playerId}/maxBricks/round2`), newMax);
            } else if (roundNum === 3) {
                const r1Snap = await get(ref(db, `rooms/${this.worldCode}/reduction_rooms/${this.roomId}/players/${this.game.playerId}/brickCount/round1`));
                const r1Count = r1Snap.val() || MIN_BRICKS_R1;
                const newMax = Math.max(Math.floor(r1Count * 0.50), 1);
                this.maxBricks.round3 = newMax;
                set(ref(db, `rooms/${this.worldCode}/reduction_rooms/${this.roomId}/players/${this.game.playerId}/maxBricks/round3`), newMax);
            }

            // Connect to new round's firebase path
            this.game.firebasePathBase = `rooms/${this.worldCode}/reduction_rooms/${this.roomId}/bricks_round_${roundNum}`;
            this.game.firebasePlayersPath = `rooms/${this.worldCode}/reduction_rooms/${this.roomId}/players`;
            this.game.listenToRoom();
            
            // Fetch old round bricks for reference
            const prevRound = roundNum - 1;
            const prevSnap = await get(ref(db, `rooms/${this.worldCode}/reduction_rooms/${this.roomId}/bricks_round_${prevRound}`));
            const prevData = prevSnap.val();
            if (prevData) {
                const myOldBricks = Object.values(prevData).filter(b => b.playerId === this.game.playerId);
                
                // Set and show reference panel
                if (this.game.updateReferenceView) {
                    this.game.updateReferenceView(myOldBricks);
                    this.game.toggleReferenceView(true);
                    const refTitle = document.getElementById('reference-panel-title');
                    if (refTitle) refTitle.innerText = `Round ${prevRound} Build`;
                }
            }

            // Restore building locks
            this.unlockBuildingControls();
        }

        // Camera setup: Unified isometric view
        this.game.camera.up.set(0, 1, 0);
        this.game.controls.target.set(this.zoneOrigin.x, 0, this.zoneOrigin.z);
        // Use 20,20,20 offset for perfect 45/45/45 isometric alignment
        this.game.camera.position.set(this.zoneOrigin.x + 20, 20, this.zoneOrigin.z + 20);
        this.game.camera.lookAt(this.zoneOrigin.x, 0, this.zoneOrigin.z);
        this.game.controls.update();

        // UI
        this.showBuildHUD(roundNum);
        
        let subtext = "Build without limits. Explain everything through the model.";
        if (roundNum === 2) subtext = "Rebuild it. Keep the core meaning, but you have fewer bricks this time.";
        if (roundNum === 3) subtext = "Rebuild it again. Extremely constrained. Strip everything but the absolute essence.";
        this.game.showModal(`Round ${roundNum}`, subtext, '📉');

        // SYNCED TIMER: Wait for endTime from Firebase
        const timeRef = ref(db, `rooms/${this.worldCode}/reduction_rooms/${this.roomId}/endTime`);
        onValue(timeRef, (snapshot) => {
            const endTime = snapshot.val();
            if (endTime) {
                this.startSyncedTimer(endTime, () => {
                    // Fallback round end if facilitator is gone
                    if (!this.game.isFacilitator) {
                        // (Usually facilitator handles this via handleRoundChange)
                    }
                });
            }
        });
    }

    startSyncedTimer(endTime, onComplete) {
        if (this.timerInterval) clearInterval(this.timerInterval);
        
        const timerEl = document.getElementById('reduction-timer');
        const update = () => {
            const now = Date.now();
            const remaining = Math.max(0, Math.floor((endTime - now) / 1000));
            
            if (timerEl) {
                const mins = Math.floor(remaining / 60);
                const secs = remaining % 60;
                timerEl.innerText = `${mins}:${secs.toString().padStart(2, '0')}`;
                
                if (remaining < 30) timerEl.style.color = '#ff4757';
                else timerEl.style.color = 'white';
            }

            if (remaining <= 0) {
                clearInterval(this.timerInterval);
                if (onComplete) onComplete();
            }
        };
        
        update();
        this.timerInterval = setInterval(update, 1000);
    }

    startReviewPhase(roundNum) {
        if (this.timerInterval) clearInterval(this.timerInterval);

        // Lock building
        this.lockBuildingControls();

        // Save how many bricks I used THIS round
        const myCount = this.game.brickCount;
        set(ref(db, `rooms/${this.worldCode}/reduction_rooms/${this.roomId}/players/${this.game.playerId}/brickCount/round${roundNum}`), myCount);

        // Zoom out
        this.zoomOutToAll();

        // Change HUD banner text
        const hudText = document.getElementById('reduction-subtext-display');
        if (hudText) hudText.innerText = "Round over! Free roam to view everyone's builds while waiting for the facilitator.";

        this.forceRendererResize();
    }

    onGameEnded() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.cleanupZoneVisuals();
        
        const hud = document.getElementById('reduction-build-hud');
        if (hud) hud.classList.add('hidden');

        if (this.game.bricksRef) off(this.game.bricksRef);
        this.game.bricks.forEach(b => this.game.scene.remove(b));
        this.game.bricks = [];

        this.game.landingScreen.classList.remove('hidden');
        this.game.uiContainer.classList.add('hidden');
        if (this.game.toggleReferenceView) this.game.toggleReferenceView(false);
        
        this.game.showScreen('reduction-lobby');
        this.unlockBuildingControls();
    }

    // ─── UTILS ────────────────────────────────────────────────────────────
    showBuildHUD(roundNum) {
        const hud = document.getElementById('reduction-build-hud');
        hud.classList.remove('hidden');

        document.getElementById('reduction-round-indicator').innerText = `ROUND ${roundNum}`;
        
        const subMap = {
            1: "Build the whole idea.",
            2: "Rebuild it smaller. Focus on the core.",
            3: "Extreme constraints. True essence only."
        };
        document.getElementById('reduction-subtext-display').innerText = subMap[roundNum];

        const brickCard = document.getElementById('reduction-brick-counter-card');
        if (roundNum === 1) {
            brickCard.classList.add('hidden');
        } else {
            brickCard.classList.remove('hidden');
            this.updateBrickCounterHUD(roundNum);
        }
    }
    
    updateBrickCounterHUD(roundNum) {
        const textEl = document.getElementById('reduction-brick-counter-text');
        if (!textEl) return;
        
        const max = roundNum === 2 ? this.maxBricks.round2 : this.maxBricks.round3;
        const current = this.game.brickCount;
        
        textEl.innerText = `${current} / ${max}`;
        if (current >= max) {
            textEl.style.color = '#cc0000'; // Dark red
        } else {
            textEl.style.color = '#ff4b4b'; // Normal red
        }
    }

    canPlaceBrick(pos) {
        if (!this.currentRound.startsWith('ROUND_')) return false;

        // ZONE ENFORCEMENT: Check coordinates
        if (!this.game.isFacilitator && pos) {
            if (!this.isInMyZone(pos)) {
                this.game.showToast("Cannot build outside your zone!", "error");
                return false;
            }
        }
        
        const currentMax = this.maxBricks[`round${this.currentRound.replace('ROUND_', '')}`] || Infinity;
        if (this.game.bricks.filter(b => b.userData.playerId === this.game.playerId).length >= currentMax) {
            this.game.showToast(`Brick limit reached (${currentMax} max)`, "warning");
            return false;
        }
        return true; 
    }
    
    onBrickPlaced() {
        if (this.currentRound === 'ROUND_2') this.updateBrickCounterHUD(2);
        if (this.currentRound === 'ROUND_3') this.updateBrickCounterHUD(3);
    }

    startTimer(seconds, callback) {
        // Redundant - we use startSyncedTimer via endTime listener now
        if (this.timerInterval) clearInterval(this.timerInterval);
    }

    lockBuildingControls() {
        document.getElementById('sidebar')?.classList.add('hidden');
        ['undo-btn', 'clear-btn', 'export-btn', 'import-btn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.add('hidden');
        });
        if (this.game.ghostBrick) this.game.ghostBrick.visible = false;
        this.game.uiContainer.classList.add('sidebar-collapsed');
    }

    unlockBuildingControls() {
        document.getElementById('sidebar')?.classList.remove('hidden');
        ['undo-btn', 'clear-btn', 'export-btn', 'import-btn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.remove('hidden');
        });
        this.game.uiContainer.classList.remove('sidebar-collapsed');
    }

    isInMyZone(position) {
        if (!this.currentRound.startsWith('ROUND_')) return false;
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

    createAllZoneVisuals(players) {
        this.cleanupZoneVisuals();

        players.forEach((p, i) => {
            const originX = i * ZONE_SPACING;
            const color = ZONE_COLORS[i % ZONE_COLORS.length];

            const planeGeom = new THREE.PlaneGeometry(ZONE_SIZE, ZONE_SIZE);
            planeGeom.rotateX(-Math.PI / 2);
            const planeMat = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.12, side: THREE.DoubleSide });
            const plane = new THREE.Mesh(planeGeom, planeMat);
            plane.position.set(originX, 0.01, 0);
            this.game.scene.add(plane);
            this.zonePlanes.push(plane);

            const borderGeom = new THREE.EdgesGeometry(new THREE.PlaneGeometry(ZONE_SIZE, ZONE_SIZE));
            const borderMat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.5 });
            const border = new THREE.LineSegments(borderGeom, borderMat);
            border.rotation.x = -Math.PI / 2;
            border.position.set(originX, 0.02, 0);
            this.game.scene.add(border);
            this.zonePlanes.push(border);

            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
            ctx.fillRect(0, 0, 512, 64);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 36px Nunito, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            const displayName = p.id === this.game.playerId ? `${p.name} (You)` : p.name;
            ctx.fillText(displayName, 256, 32);

            const spriteMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true });
            const sprite = new THREE.Sprite(spriteMat);
            sprite.scale.set(6, 0.75, 1);
            sprite.position.set(originX, 0.5, -ZONE_SIZE / 2 - 1);
            this.game.scene.add(sprite);
            this.zoneLabels.push(sprite);
        });
    }

    cleanupZoneVisuals() {
        [...this.zonePlanes, ...this.zoneLabels].forEach(obj => this.game.scene.remove(obj));
        this.zonePlanes = [];
        this.zoneLabels = [];
    }

    expandFloorForZones(playerCount) {
        const centerX = ((playerCount - 1) * ZONE_SPACING) / 2;

        if (this.game.grid) this.game.scene.remove(this.game.grid);
        // Use standard large grid instead of dynamic scaling to prevent "too big" feeling
        this.game.grid = new THREE.GridHelper(200, 200, 0xdddddd, 0x888888);
        this.game.grid.position.set(centerX, 0.005, 0); 
        this.game.scene.add(this.game.grid);
        
        if (this.game.floor) this.game.scene.remove(this.game.floor);
        const floorGeom = new THREE.PlaneGeometry(2000, 2000);
        floorGeom.rotateX(-Math.PI / 2);
        this.game.floor = new THREE.Mesh(floorGeom, new THREE.MeshBasicMaterial({ visible: false }));
        this.game.floor.position.set(centerX, 0, 0);
        this.game.scene.add(this.game.floor);
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

    forceRendererResize() {
        const doResize = () => { if (this.game && typeof this.game.onWindowResize === 'function') this.game.onWindowResize(); };
        setTimeout(doResize, 50); setTimeout(doResize, 200); setTimeout(doResize, 500);
    }

    cleanup() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.cleanupZoneVisuals();
    }
}

// ─── GALLERY MINI RENDERER ──────────────────────────────────────────────
class GalleryMiniRenderer {
    constructor(container, bricksData, gameEnv) {
        this.container = container;
        this.container.innerHTML = '';
        
        this.scene = new THREE.Scene();
        this.scene.background = null; // transparent

        const aspect = container.clientWidth / container.clientHeight;
        const d = 15;
        this.camera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 1000);
        this.camera.position.set(20, 20, 20);
        this.camera.lookAt(0, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.container.appendChild(this.renderer.domElement);

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
        const dir = new THREE.DirectionalLight(0xffffff, 0.6);
        dir.position.set(10, 20, 10);
        this.scene.add(dir);

        // Ensure OrbitControls is available, fallback to manual rotation and re-rendering if needed
        // Assuming OrbitControls is global (like in main.js, we don't have direct access here)
        // We'll just render it statically from isometric angle and center it.
        
        if (bricksData && bricksData.length > 0) {
            const group = new THREE.Group();
            const box = new THREE.Box3();
            bricksData.forEach(data => {
                const type = BRICK_TYPES.find(t => t.id === data.typeId);
                if (!type) return;
                const brick = createBrick(type, data.color, 1.0);
                brick.position.set(data.x, data.y, data.z);
                brick.rotation.y = data.ry;
                group.add(brick);
                box.expandByObject(brick);
            });
            
            const center = new THREE.Vector3();
            box.getCenter(center);
            group.children.forEach(child => child.position.sub(center));
            
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            
            // Adjust camera based on bounds
            const d = Math.max(10, maxDim * 0.6);
            this.camera.left = -d * aspect;
            this.camera.right = d * aspect;
            this.camera.top = d;
            this.camera.bottom = -d;
            this.camera.updateProjectionMatrix();

            this.scene.add(group);
            this.renderer.render(this.scene, this.camera);
        }
    }
    
    cleanup() {
        if (this.renderer) {
            this.renderer.dispose();
        }
        this.container.innerHTML = '';
    }
}
