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
    boxSelectionStart: null,
    boxSelectionEnd: null,
    history: [],
    historyIndex: -1,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
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

// ==== Coordinate Conversion ====
function toWorld(screenX, screenY) {
    return {
        x: (screenX - state.offsetX) / state.scale,
        y: (screenY - state.offsetX) / state.scale // Typo fix: offsetY
    };
}

// Correct implementation of toWorld
function screenToWorld(sx, sy) {
    return {
        x: (sx - state.offsetX) / state.scale,
        y: (sy - state.offsetY) / state.scale
    };
}

// ==== Zoom & Pan ====
canvas.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const zoomIntensity = 0.1;
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Get mouse position in world coordinates before zoom
        const worldPos = screenToWorld(mouseX, mouseY);

        // Update scale
        const delta = e.deltaY < 0 ? 1 : -1;
        const newScale = state.scale * (1 + delta * zoomIntensity);

        // Limit scale
        if (newScale < 0.1 || newScale > 5) return;

        state.scale = newScale;

        // Adjust offset so the mouse point remains in the same world position
        state.offsetX = mouseX - worldPos.x * state.scale;
        state.offsetY = mouseY - worldPos.y * state.scale;

        draw();
    }
}, { passive: false });

// ==== Mouse Interaction ====
canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const { x, y } = screenToWorld(screenX, screenY);

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
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    let { x, y } = screenToWorld(screenX, screenY);

    // Snapping logic
    const isSnapDisabled = e.ctrlKey || e.metaKey;

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
        let dx = x - state.lastMousePos.x;
        let dy = y - state.lastMousePos.y;

        // Apply snapping for move
        if (!isSnapDisabled) {
            const correction = getMoveSnapCorrection(dx, dy, state.selection);
            dx += correction.x;
            dy += correction.y;
        }

        state.selection.forEach(obj => {
            obj.x1 += dx;
            obj.y1 += dy;
            obj.x2 += dx;
            obj.y2 += dy;
        });

        // Update lastMousePos to reflect the actual movement including snap
        // This prevents drift
        state.lastMousePos = {
            x: state.lastMousePos.x + dx,
            y: state.lastMousePos.y + dy
        };

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

        // Apply snapping if enabled
        if (!isSnapDisabled) {
            const snapped = getSnappedPoint(x, y, [obj]);
            x = snapped.x;
            y = snapped.y;
        }

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

    // Apply snapping for preview
    if (!isSnapDisabled) {
        const snapped = getSnappedPoint(x, y);
        // If snapped to an object, use that point
        if (snapped.x !== x || snapped.y !== y) {
            x = snapped.x;
            y = snapped.y;
        } else {
            // Otherwise apply angle snapping (45 degree increments)
            const dx = x - state.dragStart.x;
            const dy = y - state.dragStart.y;
            const angle = Math.atan2(dy, dx);
            const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
            const dist = Math.hypot(dx, dy);
            x = state.dragStart.x + Math.cos(snappedAngle) * dist;
            y = state.dragStart.y + Math.sin(snappedAngle) * dist;
        }
    }

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
        // Convert box selection start/end to world coordinates for comparison
        // Note: boxSelectionStart/End are already in world coords because we set them using x,y from mousedown/move

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
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const { x, y } = screenToWorld(screenX, screenY);

    // Minimum length check
    const length = Math.hypot(x - state.dragStart.x, y - state.dragStart.y);
    if (length < 10) {
        state.isDragging = false;
        state.dragStart = null;
        return;
    }

    // Apply snapping for the end point of the new object
    let endX = x;
    let endY = y;
    if (!(e.ctrlKey || e.metaKey)) {
        const snapped = getSnappedPoint(x, y);
        if (snapped.x !== x || snapped.y !== y) {
            endX = snapped.x;
            endY = snapped.y;
        } else {
            // Angle snap
            const dx = x - state.dragStart.x;
            const dy = y - state.dragStart.y;
            const angle = Math.atan2(dy, dx);
            const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
            const dist = Math.hypot(dx, dy);
            endX = state.dragStart.x + Math.cos(snappedAngle) * dist;
            endY = state.dragStart.y + Math.sin(snappedAngle) * dist;
        }
    }

    const newObj = {
        type: state.mode,
        x1: state.dragStart.x,
        y1: state.dragStart.y,
        x2: endX,
        y2: endY,
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

    return distance < 8 / state.scale; // Adjust hit area for zoom
}

function getResizeHandle(px, py, obj) {
    const handleSize = 10 / state.scale; // Adjust handle size for zoom
    const dist1 = Math.hypot(px - obj.x1, py - obj.y1);
    const dist2 = Math.hypot(px - obj.x2, py - obj.y2);

    if (dist1 < handleSize) return 'start';
    if (dist2 < handleSize) return 'end';
    return null;
}

// ==== Snapping Logic ====
function getSnappedPoint(x, y, excludeObjects = []) {
    const snapThreshold = 15 / state.scale;
    let snappedX = x;
    let snappedY = y;
    let minDist = snapThreshold;

    state.objects.forEach(obj => {
        if (excludeObjects.includes(obj)) return;

        // Check start point
        const d1 = Math.hypot(x - obj.x1, y - obj.y1);
        if (d1 < minDist) {
            minDist = d1;
            snappedX = obj.x1;
            snappedY = obj.y1;
        }

        // Check end point
        const d2 = Math.hypot(x - obj.x2, y - obj.y2);
        if (d2 < minDist) {
            minDist = d2;
            snappedX = obj.x2;
            snappedY = obj.y2;
        }
    });

    return { x: snappedX, y: snappedY };
}

function getMoveSnapCorrection(dx, dy, selection) {
    const snapThreshold = 15 / state.scale;
    let correctionX = 0;
    let correctionY = 0;
    let minDist = snapThreshold;

    // We check if any endpoint of the selection snaps to any endpoint of unselected objects
    // after applying dx, dy

    const unselected = state.objects.filter(obj => !selection.includes(obj));

    if (unselected.length === 0) return { x: 0, y: 0 };

    for (const selObj of selection) {
        // Proposed new positions
        const p1x = selObj.x1 + dx;
        const p1y = selObj.y1 + dy;
        const p2x = selObj.x2 + dx;
        const p2y = selObj.y2 + dy;

        for (const target of unselected) {
            // Check p1 against target endpoints
            const d1_t1 = Math.hypot(p1x - target.x1, p1y - target.y1);
            if (d1_t1 < minDist) {
                minDist = d1_t1;
                correctionX = target.x1 - p1x;
                correctionY = target.y1 - p1y;
            }

            const d1_t2 = Math.hypot(p1x - target.x2, p1y - target.y2);
            if (d1_t2 < minDist) {
                minDist = d1_t2;
                correctionX = target.x2 - p1x;
                correctionY = target.y2 - p1y;
            }

            // Check p2 against target endpoints
            const d2_t1 = Math.hypot(p2x - target.x1, p2y - target.y1);
            if (d2_t1 < minDist) {
                minDist = d2_t1;
                correctionX = target.x1 - p2x;
                correctionY = target.y1 - p2y;
            }

            const d2_t2 = Math.hypot(p2x - target.x2, p2y - target.y2);
            if (d2_t2 < minDist) {
                minDist = d2_t2;
                correctionX = target.x2 - p2x;
                correctionY = target.y2 - p2y;
            }
        }
    }

    return { x: correctionX, y: correctionY };
}

function draw() {
    // clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(state.offsetX, state.offsetY);
    ctx.scale(state.scale, state.scale);

    // draw grid
    drawGrid();
    // draw objects
    state.objects.forEach(obj => {
        ctx.strokeStyle = getColorForType(obj.type);
        ctx.lineWidth = 3 / state.scale; // Keep outline width constant visually
        ctx.beginPath();
        ctx.moveTo(obj.x1, obj.y1);
        ctx.lineTo(obj.x2, obj.y2);
        ctx.stroke();
    });
    // highlight selected
    state.selection.forEach(obj => {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 4 / state.scale; // Keep outline width constant visually
        ctx.setLineDash([4 / state.scale, 2 / state.scale]);
        ctx.beginPath();
        ctx.moveTo(obj.x1, obj.y1);
        ctx.lineTo(obj.x2, obj.y2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw resize handles only if single selection
        if (state.selection.length === 1) {
            ctx.fillStyle = '#fff';
            const handleSize = 5 / state.scale;
            ctx.beginPath();
            ctx.arc(obj.x1, obj.y1, handleSize, 0, Math.PI * 2);
            ctx.arc(obj.x2, obj.y2, handleSize, 0, Math.PI * 2);
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
        ctx.lineWidth = 1 / state.scale;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
    }

    // Draw rotation center for visual feedback
    if (state.isRotating && state.rotationCenter) {
        ctx.fillStyle = '#ff0';
        ctx.beginPath();
        ctx.arc(state.rotationCenter.x, state.rotationCenter.y, 4 / state.scale, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();
}

function drawGrid() {
    // Calculate visible area in world coordinates
    const left = -state.offsetX / state.scale;
    const top = -state.offsetY / state.scale;
    const right = (canvas.width - state.offsetX) / state.scale;
    const bottom = (canvas.height - state.offsetY) / state.scale;

    const step = 40; // 40px grid spacing
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1 / state.scale;

    // Snap start to grid
    const startX = Math.floor(left / step) * step;
    const startY = Math.floor(top / step) * step;

    for (let x = startX; x < right; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
    }
    for (let y = startY; y < bottom; y += step) {
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
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
