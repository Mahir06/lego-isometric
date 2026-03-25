import * as THREE from 'three';

const STUD_RADIUS = 0.25;
const STUD_HEIGHT = 0.2;
const UNIT = 1.0;
const GAP = 0.02; // Slightly more gap to prevent z-fighting in isometric

export function createBrick(type, color, opacity = 1.0) {
    const group = new THREE.Group();
    const width = type.w;
    const depth = type.d;
    const height = type.h;

    const material = new THREE.MeshPhongMaterial({ 
        color: color, 
        specular: 0x222222,
        shininess: 50,
        transparent: opacity < 1.0,
        opacity: opacity,
        depthWrite: opacity === 1.0
    });

    let body;
    if (type.shape === 'cylinder') {
        const geom = new THREE.CylinderGeometry(width * UNIT / 2 - GAP, width * UNIT / 2 - GAP, height, 32);
        body = new THREE.Mesh(geom, material);
        body.position.y = height / 2;
    } else if (type.shape === 'rod') {
        const geom = new THREE.CylinderGeometry(0.125, 0.125, height, 16);
        body = new THREE.Mesh(geom, material);
        body.position.y = height / 2;
    } else if (type.shape === 'technic') {
        const geom = new THREE.BoxGeometry(width * UNIT - GAP, height, depth * UNIT - GAP);
        body = new THREE.Mesh(geom, material);
        body.position.y = height / 2;
        
        // Add hole visual (visual only for now)
        const holeCount = Math.floor(width);
        for (let i = 0; i < holeCount; i++) {
            const holeOffset = -(width * UNIT) / 2 + UNIT / 2 + i * UNIT;
            const holeGeom = new THREE.CylinderGeometry(0.2, 0.2, depth * UNIT + 0.02, 16);
            const holeMat = new THREE.MeshPhongMaterial({ 
                color: 0x111111,
                transparent: opacity < 1.0,
                opacity: opacity,
                depthWrite: opacity === 1.0
            });
            const hole = new THREE.Mesh(holeGeom, holeMat);
            hole.rotateX(Math.PI / 2);
            hole.position.set(holeOffset, 0, 0);
            hole.userData.isHole = true;
            body.add(hole);
        }
    } else {
        const geom = new THREE.BoxGeometry(width * UNIT - GAP, height, depth * UNIT - GAP);
        body = new THREE.Mesh(geom, material);
        body.position.y = height / 2;
    }

    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Add studs
    if (type.studs) {
        const studGeom = new THREE.CylinderGeometry(STUD_RADIUS, STUD_RADIUS, STUD_HEIGHT, 16);
        type.studs.forEach(s => {
            if (s.pos === 'top') {
                const startX = -(width * UNIT) / 2 + UNIT / 2;
                const startZ = -(depth * UNIT) / 2 + UNIT / 2;
                for (let x = 0; x < width; x++) {
                    for (let z = 0; z < depth; z++) {
                        const m = new THREE.Mesh(studGeom, material);
                        m.position.set(startX + x * UNIT, height + STUD_HEIGHT / 2, startZ + z * UNIT);
                        m.castShadow = true;
                        m.receiveShadow = true;
                        m.userData.isStud = true;
                        m.userData.type = 'top';
                        group.add(m);
                    }
                }
            } else if (s.pos === 'side') {
                const stud = new THREE.Mesh(studGeom, material);
                stud.rotateX(Math.PI / 2);
                stud.position.set(s.x, s.y, s.z);
                stud.castShadow = true;
                stud.receiveShadow = true;
                stud.userData.isStud = true;
                stud.userData.type = 'side';
                group.add(stud);
            }
        });
    }

    // Border for "LEGO" look
    if (type.shape !== 'cylinder') {
        const edges = new THREE.EdgesGeometry(body.geometry);
        const edgeOpacity = opacity < 1.0 ? 0.05 : 0.1;
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ 
            color: 0x000000, 
            transparent: true, 
            opacity: edgeOpacity 
        }));
        body.add(line);
    }

    group.userData.width = width;
    group.userData.depth = depth;
    group.userData.height = height;
    group.userData.typeId = type.id;
    group.userData.hasStuds = !!type.studs && type.studs.some(s => s.pos === 'top');
    group.userData.color = color;

    return group;
}

export const BRICK_TYPES = [
    // --- Bricks ---
    { id: '1x1', w: 1, d: 1, h: 1, shape: 'box', studs: [{pos: 'top'}], cat: 'Bricks' },
    { id: '1x2', w: 2, d: 1, h: 1, shape: 'box', studs: [{pos: 'top'}], cat: 'Bricks' },
    { id: '1x3', w: 3, d: 1, h: 1, shape: 'box', studs: [{pos: 'top'}], cat: 'Bricks' },
    { id: '1x4', w: 4, d: 1, h: 1, shape: 'box', studs: [{pos: 'top'}], cat: 'Bricks' },
    { id: '2x2', w: 2, d: 2, h: 1, shape: 'box', studs: [{pos: 'top'}], cat: 'Bricks' },
    { id: '2x4', w: 4, d: 2, h: 1, shape: 'box', studs: [{pos: 'top'}], cat: 'Bricks' },
    
    // --- Plates ---
    { id: '1x1 P', w: 1, d: 1, h: 1/3, shape: 'box', studs: [{pos: 'top'}], cat: 'Plates' },
    { id: '1x2 P', w: 2, d: 1, h: 1/3, shape: 'box', studs: [{pos: 'top'}], cat: 'Plates' },
    { id: '2x2 P', w: 2, d: 2, h: 1/3, shape: 'box', studs: [{pos: 'top'}], cat: 'Plates' },
    { id: '2x4 P', w: 4, d: 2, h: 1/3, shape: 'box', studs: [{pos: 'top'}], cat: 'Plates' },
    { id: '2x6 P', w: 6, d: 2, h: 1/3, shape: 'box', studs: [{pos: 'top'}], cat: 'Plates' },
    
    // --- Tiles ---
    { id: '1x1 T', w: 1, d: 1, h: 1/3, shape: 'box', cat: 'Tiles' },
    { id: '1x2 T', w: 2, d: 1, h: 1/3, shape: 'box', cat: 'Tiles' },
    { id: '2x2 T', w: 2, d: 2, h: 1/3, shape: 'box', cat: 'Tiles' },

    // --- Rounds ---
    { id: 'R 1x1', w: 1, d: 1, h: 1, shape: 'cylinder', studs: [{pos: 'top'}], cat: 'Rounds' },
    { id: 'R 2x2', w: 2, d: 2, h: 1, shape: 'cylinder', studs: [{pos: 'top'}], cat: 'Rounds' },
    { id: 'R 1x1 P', w: 1, d: 1, h: 1/3, shape: 'cylinder', studs: [{pos: 'top'}], cat: 'Rounds' },

    // --- Technic ---
    { id: 'T 1x1', w: 1, d: 1, h: 1, shape: 'technic', studs: [{pos: 'top'}], cat: 'Technic' },
    { id: 'T 1x2', w: 2, d: 1, h: 1, shape: 'technic', studs: [{pos: 'top'}], cat: 'Technic' },
    { id: 'T 1x4', w: 4, d: 1, h: 1, shape: 'technic', studs: [{pos: 'top'}], cat: 'Technic' },

    // --- Rods ---
    { id: 'Rod 3L', w: 1, d: 1, h: 3, shape: 'rod', cat: 'Rods' },

    // --- Special ---
    { id: '1x1 H', w: 1, d: 1, h: 1, shape: 'box', studs: [{pos: 'top'}, {pos: 'side', x: 0, y: 0.5, z: 0.5}], cat: 'Special' },
];

export const BRICK_COLORS = [
    { name: 'Red', hex: 0xd32f2f },
    { name: 'Blue', hex: 0x1976d2 },
    { name: 'Yellow', hex: 0xfbc02d },
    { name: 'Green', hex: 0x388e3c },
    { name: 'White', hex: 0xf5f5f5 },
    { name: 'Black', hex: 0x212121 },
    { name: 'Orange', hex: 0xff9800 },
    { name: 'Trans-Blue', hex: 0x81d4fa, opacity: 0.6 },
];
