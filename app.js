// app.js - Core logic for 2D floorplan editor and 3D preview
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ==== Global State ====
const state = {
    mode: null, // 'wall', 'door', 'window', 'furniture'
    objects: [], // {type, x1, y1, x2, y2, ...}
    selection: [], // Array of selected objects
    isDragging: false,
    dragStart: null,
    isResizing: false,
    resizeHandle: null, // 'start' or 'end'
    isMoving: false,
    lastMousePos: null,
    isRotating: false,
    rotationCenter: null, // {x, y}
    rotationStartAngle: 0,
    initialObjectStates: [], // Store initial states for rotation
    isBoxSelecting: false,
    boxSelectionStart: null,
    boxSelectionEnd: null,
    history: [],
    historyIndex: -1,
};

// ==== Canvas Setup ====
const canvas = document.getElementById('floorplan-canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    draw();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ==== Toolbar Handlers ====
document.getElementById('select-mode').onclick = () => setMode(null);
document.getElementById('add-wall').onclick = () => setMode('wall');
document.getElementById('add-door').onclick = () => setMode('door');
document.getElementById('add-window').onclick = () => setMode('window');
document.getElementById('add-furniture').onclick = () => setMode('furniture');

document.getElementById('preview-3d').onclick = open3DPreview;
document.getElementById('export').onclick = exportFloorplan;
document.getElementById('import').onclick = () => document.getElementById('import-file').click();

document.getElementById('undo').onclick = undo;
document.getElementById('redo').onclick = redo;
document.getElementById('delete').onclick = deleteSelected;

// Hidden file input for import
const importInput = document.createElement('input');
importInput.type = 'file';
importInput.accept = '.json';
importInput.id = 'import-file';
importInput.style.display = 'none';
importInput.addEventListener('change', handleImport);
document.body.appendChild(importInput);

function setMode(mode) {
    state.mode = mode;
    state.selection = [];
    updateToolbar();
}

function updateToolbar() {
    // Update active state for tool buttons
    document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
    if (state.mode === 'wall') document.getElementById('add-wall').classList.add('active');
    else if (state.mode === 'door') document.getElementById('add-door').classList.add('active');
    else if (state.mode === 'window') document.getElementById('add-window').classList.add('active');
    else if (state.mode === 'furniture') document.getElementById('add-furniture').classList.add('active');
    else document.getElementById('select-mode').classList.add('active');

    const undoBtn = document.getElementById('undo');
    const redoBtn = document.getElementById('redo');
    const deleteBtn = document.getElementById('delete');

    undoBtn.disabled = state.historyIndex < 0;
    redoBtn.disabled = state.historyIndex >= state.history.length - 1;
    deleteBtn.disabled = state.selection.length === 0;
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selection.length > 0 && !e.target.matches('input, textarea')) {
            e.preventDefault();
            deleteSelected();
        }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
            redo();
        } else {
            undo();
        }
    }
    if (e.key === 'Escape') {
        state.mode = null;
        state.selection = [];
        state.isResizing = false;
        state.isBoxSelecting = false;
        updateToolbar();
        draw();
    }
});

// ==== Mouse Interaction ====
canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (state.mode) {
        // start drawing a new object
        state.isDragging = true;
        state.dragStart = { x, y };
    } else {
        // Check if clicking on a resize handle (only if single selection)
        if (state.selection.length === 1) {
            const handle = getResizeHandle(x, y, state.selection[0]);
            if (handle) {
                state.isResizing = true;
                state.resizeHandle = handle;
                state.dragStart = { x, y };
                return;
            }
        }

        // selection logic
        const hit = state.objects.find(obj => pointInObject(x, y, obj));
        if (hit) {
            // Check if we are clicking on an already selected object
            if (state.selection.includes(hit)) {
                if (e.shiftKey) {
                    // Start rotation
                    state.isRotating = true;

                    // Calculate group center
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    state.selection.forEach(obj => {
                        minX = Math.min(minX, obj.x1, obj.x2);
                        minY = Math.min(minY, obj.y1, obj.y2);
                        maxX = Math.max(maxX, obj.x1, obj.x2);
                        maxY = Math.max(maxY, obj.y1, obj.y2);
                    });
                    const centerX = (minX + maxX) / 2;
                    const centerY = (minY + maxY) / 2;
                    state.rotationCenter = { x: centerX, y: centerY };

                    state.rotationStartAngle = Math.atan2(y - centerY, x - centerX);

                    // Store initial states relative to group center
                    state.initialObjectStates = state.selection.map(obj => {
                        // Store endpoints relative to center
                        const p1 = { x: obj.x1 - centerX, y: obj.y1 - centerY };
                        const p2 = { x: obj.x2 - centerX, y: obj.y2 - centerY };
                        return { obj, p1, p2 };
                    });
                } else if (!(e.ctrlKey || e.metaKey)) {
                    // Start moving
                    state.isMoving = true;
                    state.lastMousePos = { x, y };
                } else {
                    // Ctrl click on selected object: deselect
                    const idx = state.selection.indexOf(hit);
                    state.selection.splice(idx, 1);
                }
            } else {
                // Toggle selection if Ctrl is pressed
                if (e.ctrlKey || e.metaKey) {
                    const idx = state.selection.indexOf(hit);
                    if (idx > -1) state.selection.splice(idx, 1);
                    else state.selection.push(hit);
                } else {
                    // Select only this object
                    state.selection = [hit];
                    if (e.shiftKey) {
                        // Start rotation immediately for newly selected object
                        state.isRotating = true;
                        const centerX = (hit.x1 + hit.x2) / 2;
                        const centerY = (hit.y1 + hit.y2) / 2;
                        state.rotationCenter = { x: centerX, y: centerY };
                        state.rotationStartAngle = Math.atan2(y - centerY, x - centerX);

                        state.initialObjectStates = [{
                            obj: hit,
                            p1: { x: hit.x1 - centerX, y: hit.y1 - centerY },
                            p2: { x: hit.x2 - centerX, y: hit.y2 - centerY }
                        }];
                    } else {
                        state.isMoving = true;
                        state.lastMousePos = { x, y };
                    }
                }
            }
        } else {
            // Clicked on empty space
            if (!(e.ctrlKey || e.metaKey)) {
                state.selection = [];
            }
            // Start box selection
            state.isBoxSelecting = true;
            state.boxSelectionStart = { x, y };
            state.boxSelectionEnd = { x, y };
        }

        updateToolbar();
        draw();
    }
});

canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Update cursor based on hover
    if (!state.isDragging && !state.isResizing && !state.isBoxSelecting && !state.isMoving && !state.isRotating) {
        if (state.selection.length === 1) {
            const handle = getResizeHandle(x, y, state.selection[0]);
            if (handle) {
                canvas.style.cursor = 'pointer';
                return;
            }
        }

        // Check if hovering over a selected object
        const hit = state.objects.find(obj => pointInObject(x, y, obj));
        if (hit && state.selection.includes(hit)) {
            canvas.style.cursor = e.shiftKey ? 'alias' : 'move'; // 'alias' as rotation cursor
        } else {
            canvas.style.cursor = 'default';
        }
    }

    if (state.isRotating) {
        // Rotate all objects around the group center
        if (state.initialObjectStates.length > 0) {
            const cx = state.rotationCenter.x;
            const cy = state.rotationCenter.y;
            const currentAngle = Math.atan2(y - cy, x - cx);
            const deltaAngle = currentAngle - state.rotationStartAngle;

            const cos = Math.cos(deltaAngle);
            const sin = Math.sin(deltaAngle);

            state.initialObjectStates.forEach(item => {
                // Rotate p1
                item.obj.x1 = cx + (item.p1.x * cos - item.p1.y * sin);
                item.obj.y1 = cy + (item.p1.x * sin + item.p1.y * cos);

                // Rotate p2
                item.obj.x2 = cx + (item.p2.x * cos - item.p2.y * sin);
                item.obj.y2 = cy + (item.p2.x * sin + item.p2.y * cos);
            });

            draw();

            // Draw rotation center for visual feedback
            ctx.fillStyle = '#ff0';
            ctx.beginPath();
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fill();
        }
        return;
    }

    if (state.isMoving) {
        const dx = x - state.lastMousePos.x;
        const dy = y - state.lastMousePos.y;

        state.selection.forEach(obj => {
            obj.x1 += dx;
            obj.y1 += dy;
            obj.x2 += dx;
            obj.y2 += dy;
        });

        state.lastMousePos = { x, y };
        draw();
        return;
    }

    if (state.isBoxSelecting) {
        state.boxSelectionEnd = { x, y };
        draw();
        return;
    }

    if (state.isResizing && state.selection.length === 1) {
        // Resize the selected object
        const obj = state.selection[0];
        if (state.resizeHandle === 'start') {
            obj.x1 = x;
            obj.y1 = y;
        } else if (state.resizeHandle === 'end') {
            obj.x2 = x;
            obj.y2 = y;
        }
        draw();
        return;
    }

    if (!state.isDragging) return;

    // temporary preview – we just redraw with a provisional object
    draw();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(state.dragStart.x, state.dragStart.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.setLineDash([]);
});

canvas.addEventListener('mouseup', (e) => {
    if (state.isBoxSelecting) {
        // Finalize box selection
        const x1 = Math.min(state.boxSelectionStart.x, state.boxSelectionEnd.x);
        const x2 = Math.max(state.boxSelectionStart.x, state.boxSelectionEnd.x);
        const y1 = Math.min(state.boxSelectionStart.y, state.boxSelectionEnd.y);
        const y2 = Math.max(state.boxSelectionStart.y, state.boxSelectionEnd.y);

        const selected = state.objects.filter(obj => {
            // Check if object is fully contained in box
            // For lines, both endpoints must be inside
            const p1Inside = obj.x1 >= x1 && obj.x1 <= x2 && obj.y1 >= y1 && obj.y1 <= y2;
            const p2Inside = obj.x2 >= x1 && obj.x2 <= x2 && obj.y2 >= y1 && obj.y2 <= y2;
            return p1Inside && p2Inside;
        });

        if (e.ctrlKey || e.metaKey) {
            // Add to existing selection
            selected.forEach(obj => {
                if (!state.selection.includes(obj)) state.selection.push(obj);
            });
        } else {
            state.selection = selected;
        }

        state.isBoxSelecting = false;
        state.boxSelectionStart = null;
        state.boxSelectionEnd = null;
        updateToolbar();
        draw();
        return;
    }

    if (state.isRotating) {
        saveToHistory();
        state.isRotating = false;
        state.initialObjectStates = [];
        state.rotationCenter = null;
        return;
    }

    if (state.isMoving) {
        saveToHistory();
        state.isMoving = false;
        state.lastMousePos = null;
        return;
    }

    if (state.isResizing) {
        saveToHistory();
        state.isResizing = false;
        state.resizeHandle = null;
        return;
    }

    if (!state.isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Minimum length check
    const length = Math.hypot(x - state.dragStart.x, y - state.dragStart.y);
    if (length < 10) {
        state.isDragging = false;
        state.dragStart = null;
        return;
    }

    const newObj = {
        type: state.mode,
        x1: state.dragStart.x,
        y1: state.dragStart.y,
        x2: x,
        y2: y,
    };
    state.objects.push(newObj);
    saveToHistory();
    state.isDragging = false;
    state.dragStart = null;
    draw();
});

function pointInObject(px, py, obj) {
    // Distance from point to line segment
    const A = px - obj.x1;
    const B = py - obj.y1;
    const C = obj.x2 - obj.x1;
    const D = obj.y2 - obj.y1;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;

    if (lenSq !== 0) param = dot / lenSq;

    let xx, yy;

    if (param < 0) {
        xx = obj.x1;
        yy = obj.y1;
    } else if (param > 1) {
        xx = obj.x2;
        yy = obj.y2;
    } else {
        xx = obj.x1 + param * C;
        yy = obj.y1 + param * D;
    }

    const dx = px - xx;
    const dy = py - yy;
    const distance = Math.sqrt(dx * dx + dy * dy);

    return distance < 8;
}

function getResizeHandle(px, py, obj) {
    const handleSize = 10;
    const dist1 = Math.hypot(px - obj.x1, py - obj.y1);
    const dist2 = Math.hypot(px - obj.x2, py - obj.y2);

    if (dist1 < handleSize) return 'start';
    if (dist2 < handleSize) return 'end';
    return null;
}

function draw() {
    // clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // draw grid
    drawGrid();
    // draw objects
    state.objects.forEach(obj => {
        ctx.strokeStyle = getColorForType(obj.type);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(obj.x1, obj.y1);
        ctx.lineTo(obj.x2, obj.y2);
        ctx.stroke();
    });
    // highlight selected
    state.selection.forEach(obj => {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 4;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(obj.x1, obj.y1);
        ctx.lineTo(obj.x2, obj.y2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw resize handles only if single selection
        if (state.selection.length === 1) {
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(obj.x1, obj.y1, 5, 0, Math.PI * 2);
            ctx.arc(obj.x2, obj.y2, 5, 0, Math.PI * 2);
            ctx.fill();
        }
    });

    // Draw box selection
    if (state.isBoxSelecting && state.boxSelectionStart && state.boxSelectionEnd) {
        const x = Math.min(state.boxSelectionStart.x, state.boxSelectionEnd.x);
        const y = Math.min(state.boxSelectionStart.y, state.boxSelectionEnd.y);
        const w = Math.abs(state.boxSelectionEnd.x - state.boxSelectionStart.x);
        const h = Math.abs(state.boxSelectionEnd.y - state.boxSelectionStart.y);

        ctx.fillStyle = 'rgba(0, 255, 204, 0.1)';
        ctx.strokeStyle = 'rgba(0, 255, 204, 0.5)';
        ctx.lineWidth = 1;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
    }
}

// ==== History & Editing ====
function saveToHistory() {
    // Remove any future history if we were in the middle of the stack
    if (state.historyIndex < state.history.length - 1) {
        state.history = state.history.slice(0, state.historyIndex + 1);
    }

    // Deep copy objects
    const snapshot = JSON.parse(JSON.stringify(state.objects));
    state.history.push(snapshot);
    state.historyIndex++;

    // Limit history size
    if (state.history.length > 50) {
        state.history.shift();
        state.historyIndex--;
    }

    updateToolbar();
}

function undo() {
    if (state.historyIndex > 0) {
        state.historyIndex--;
        state.objects = JSON.parse(JSON.stringify(state.history[state.historyIndex]));
        state.selection = [];
        draw();
        updateToolbar();
    } else if (state.historyIndex === 0) {
        // Initial empty state
        state.historyIndex = -1;
        state.objects = [];
        state.selection = [];
        draw();
        updateToolbar();
    }
}

function redo() {
    if (state.historyIndex < state.history.length - 1) {
        state.historyIndex++;
        state.objects = JSON.parse(JSON.stringify(state.history[state.historyIndex]));
        state.selection = [];
        draw();
        updateToolbar();
    }
}

function deleteSelected() {
    if (state.selection.length > 0) {
        state.objects = state.objects.filter(obj => !state.selection.includes(obj));
        state.selection = [];
        saveToHistory();
        draw();
        updateToolbar();
    }
}

function drawGrid() {
    const step = 40; // 40px grid spacing
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }
}

function getColorForType(type) {
    switch (type) {
        case 'wall': return 'hsl(170, 60%, 45%)';
        case 'door': return 'hsl(45, 80%, 55%)';
        case 'window': return 'hsl(200, 80%, 55%)';
        case 'furniture': return 'hsl(300, 60%, 55%)';
        default: return '#fff';
    }
}

// ==== Export / Import ====
function exportFloorplan() {
    const dataStr = JSON.stringify(state.objects, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'floorplan.json';
    a.click();
    URL.revokeObjectURL(url);
}

function handleImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const objs = JSON.parse(e.target.result);
            state.objects = objs;
            draw();
        } catch (err) {
            alert('Invalid floorplan file');
        }
    };
    reader.readAsText(file);
}

// ==== 3D Preview ====
let previewRenderer, previewScene, previewCamera, orbitControls;
function open3DPreview() {
    const modal = document.getElementById('preview-modal');
    modal.classList.remove('hidden');
    initThree();
    renderThree();
}

function close3DPreview() {
    const modal = document.getElementById('preview-modal');
    modal.classList.add('hidden');
    // clean up three resources
    if (previewRenderer) previewRenderer.dispose();
}

document.getElementById('close-modal').onclick = close3DPreview;

function initThree() {
    const previewCanvas = document.getElementById('preview-canvas');
    previewRenderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true });
    previewRenderer.setSize(previewCanvas.clientWidth, previewCanvas.clientHeight);

    previewScene = new THREE.Scene();
    previewScene.background = new THREE.Color(0x1a1a1a);
    previewCamera = new THREE.PerspectiveCamera(60, previewCanvas.clientWidth / previewCanvas.clientHeight, 0.1, 2000);
    previewCamera.position.set(300, 400, 300);
    previewCamera.lookAt(0, 0, 0);
    orbitControls = new OrbitControls(previewCamera, previewRenderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.05;

    // Light
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    previewScene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(200, 300, 200);
    dirLight.castShadow = true;
    previewScene.add(dirLight);

    // Add hemisphere light for better ambient lighting
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
    hemiLight.position.set(0, 300, 0);
    previewScene.add(hemiLight);

    // Floor plane - smaller and centered
    const floorSize = Math.max(canvas.width, canvas.height) * 1.5;
    const floorGeom = new THREE.PlaneGeometry(floorSize, floorSize);
    const floorMat = new THREE.MeshStandardMaterial({
        color: 0x2a2a2a,
        side: THREE.DoubleSide,
        roughness: 0.8,
        metalness: 0.2
    });
    const floor = new THREE.Mesh(floorGeom, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    previewScene.add(floor);

    // Convert 2D objects to 3D
    state.objects.forEach(obj => {
        const length = Math.hypot(obj.x2 - obj.x1, obj.y2 - obj.y1);
        const height = obj.type === 'wall' ? 80 : (obj.type === 'door' ? 60 : 40);
        const thickness = obj.type === 'wall' ? 8 : 5;
        const geometry = new THREE.BoxGeometry(length, height, thickness);
        const material = new THREE.MeshStandardMaterial({
            color: getThreeColor(obj.type),
            roughness: 0.7,
            metalness: 0.3
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        // position at midpoint
        const midX = (obj.x1 + obj.x2) / 2 - canvas.width / 2;
        const midY = (obj.y1 + obj.y2) / 2 - canvas.height / 2;
        mesh.position.set(midX, height / 2, -midY);
        // rotate to match direction
        const angle = Math.atan2(obj.y2 - obj.y1, obj.x2 - obj.x1);
        mesh.rotation.y = -angle;
        previewScene.add(mesh);
    });
}

function getThreeColor(type) {
    switch (type) {
        case 'wall': return 0x00ffcc;
        case 'door': return 0xffd700;
        case 'window': return 0x87cefa;
        case 'furniture': return 0xff69b4;
        default: return 0xffffff;
    }
}

function renderThree() {
    if (!previewRenderer) return;
    orbitControls.update();
    previewRenderer.render(previewScene, previewCamera);
    requestAnimationFrame(renderThree);
}

// Initial draw
draw();
