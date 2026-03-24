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
        opacity: opacity
    });

    let body;
    const gap = type.noGap ? 0 : GAP;
    if (type.shape === 'cylinder') {
        const geom = new THREE.CylinderGeometry(width * UNIT / 2 - gap, width * UNIT / 2 - gap, height, 32);
        body = new THREE.Mesh(geom, material);
        body.position.y = height / 2;
    } else if (type.shape === 'slope') {
        const shape = new THREE.Shape();
        shape.moveTo(-width * UNIT / 2 + gap, -height / 2);
        shape.lineTo(width * UNIT / 2 - gap, -height / 2);
        shape.lineTo(width * UNIT / 2 - gap, height / 2 - 1/3); // Exact fraction
        shape.lineTo(-width * UNIT / 2 + gap, height / 2);
        shape.lineTo(-width * UNIT / 2 + gap, -height / 2);

        const extrudeSettings = { depth: depth * UNIT - gap, bevelEnabled: false };
        const geom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        geom.rotateY(Math.PI / 2);
        body = new THREE.Mesh(geom, material);
        body.position.y = height / 2;
        body.position.z = -(depth * UNIT - gap) / 2;
    } else {
        const geom = new THREE.BoxGeometry(width * UNIT - gap, height, depth * UNIT - gap);
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
                        group.add(m);
                    }
                }
            } else if (s.pos === 'side') {
                const stud = new THREE.Mesh(studGeom, material);
                stud.rotateX(Math.PI / 2);
                stud.position.set(s.x, s.y, s.z);
                stud.castShadow = true;
                stud.receiveShadow = true;
                group.add(stud);
            }
        });
    }

    // Border for "LEGO" look
    if (type.shape !== 'cylinder') {
        const edges = new THREE.EdgesGeometry(body.geometry);
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.1 }));
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

    // --- Slopes ---
    { id: 'S 2x1', w: 2, d: 1, h: 1, shape: 'slope', cat: 'Slopes' },
    { id: 'S 3x1', w: 3, d: 1, h: 1, shape: 'slope', cat: 'Slopes' },
    { id: 'S 4x2', w: 4, d: 2, h: 1, shape: 'slope', cat: 'Slopes' },

    // --- Special ---
    { id: '1x1 H', w: 1, d: 1, h: 1, shape: 'box', studs: [{pos: 'top'}, {pos: 'side', x: 0, y: 0.5, z: 0.5}], cat: 'Special' },

    // --- Baseplates ---
    { id: '32x32 BP', w: 32, d: 32, h: 1/3, shape: 'box', studs: [{pos: 'top'}], cat: 'Baseplates', noGap: true },
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
