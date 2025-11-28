// app.js - Core logic for 2D floorplan editor and 3D preview
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as Geometry from './geometry.js';
import * as History from './history.js';

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
    showPropertyPanel: false, // Toggle state for property panel
    history: [],
    historyIndex: -1,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    clipboard: [],
    lastContextWorld: null,
};

const TYPE_DEFAULTS = {
    wall: { width: 3, height: 80, color: '#00ffcc' },
    door: { width: 2, height: 70, color: '#ffd700' },
    window: { width: 2, height: 50, color: '#87cefa' },
    furniture: { width: 3, height: 45, color: '#ff69b4' },
};

function getTypeDefaults(type) {
    const base = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.wall;
    return { ...base };
}

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

// Property Panel Events
document.getElementById('toggle-properties').onclick = togglePropertyPanel;
document.getElementById('prop-x').onchange = (e) => applyPropertyChange('x', parseFloat(e.target.value));
document.getElementById('prop-y').onchange = (e) => applyPropertyChange('y', parseFloat(e.target.value));
document.getElementById('prop-length').onchange = (e) => applyPropertyChange('length', parseFloat(e.target.value));
document.getElementById('prop-angle').onchange = (e) => applyPropertyChange('angle', parseFloat(e.target.value));
document.getElementById('prop-door-type').onchange = (e) => applyPropertyChange('subtype', e.target.value);
document.getElementById('prop-door-open').onchange = (e) => applyPropertyChange('isOpen', e.target.checked);
document.getElementById('prop-width').onchange = (e) => applyPropertyChange('width', parseFloat(e.target.value));
document.getElementById('prop-height').onchange = (e) => applyPropertyChange('height', parseFloat(e.target.value));
document.getElementById('prop-color').onchange = (e) => applyPropertyChange('color', e.target.value);

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

// Context menu elements
const contextMenu = document.getElementById('context-menu');
const menuCopy = document.getElementById('menu-copy');
const menuPaste = document.getElementById('menu-paste');
const menuFlipH = document.getElementById('menu-flip-h');
const menuFlipV = document.getElementById('menu-flip-v');
const menuDelete = document.getElementById('menu-delete');

canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    state.lastContextWorld = screenToWorld(screenX, screenY);

    updateContextMenuState();
    showContextMenu(e.clientX, e.clientY);
});

document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) hideContextMenu();
});

document.addEventListener('wheel', hideContextMenu, { passive: true });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
});

menuCopy.onclick = () => { hideContextMenu(); copySelection(); };
menuPaste.onclick = () => { hideContextMenu(); pasteClipboard(); };
menuFlipH.onclick = () => { hideContextMenu(); flipSelection('horizontal'); };
menuFlipV.onclick = () => { hideContextMenu(); flipSelection('vertical'); };
menuDelete.onclick = () => { hideContextMenu(); deleteSelected(); };

function setMode(mode) {
    state.mode = mode;
    state.selection = [];
    updateToolbar();

    // Show/hide door type select
    const doorSelect = document.getElementById('door-type');
    if (mode === 'door') {
        doorSelect.classList.remove('hidden');
    } else {
        doorSelect.classList.add('hidden');
    }
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

    // Update door open checkbox
    const doorOpenControl = document.getElementById('door-open-control');
    const doorOpenInput = document.getElementById('door-open');

    if (state.selection.length === 1 && state.selection[0].type === 'door') {
        doorOpenControl.classList.remove('hidden');
        doorOpenInput.checked = !!state.selection[0].isOpen;
    } else {
        doorOpenControl.classList.add('hidden');
    }

    updatePropertyPanel();
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
                    // Start moving (potential)
                    state.isPotentialMove = true;
                    state.lastMousePos = { x, y };
                    state.dragStart = { x, y }; // Use dragStart to check threshold
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
                        state.isPotentialMove = true;
                        state.lastMousePos = { x, y };
                        state.dragStart = { x, y };
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

window.addEventListener('mousemove', (e) => {
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

    if (state.isPotentialMove) {
        const dist = Math.hypot(x - state.dragStart.x, y - state.dragStart.y);
        if (dist > 5 / state.scale) { // 5px threshold
            state.isMoving = true;
            state.isPotentialMove = false;
        }
    }

    if (state.isMoving) {
        let dx = x - state.lastMousePos.x;
        let dy = y - state.lastMousePos.y;

        // Apply snapping for move
        if (!isSnapDisabled) {
            const correction = Geometry.getMoveSnapCorrection(dx, dy, state.selection, state.objects, state.scale);
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

        updatePropertyPanel(); // Update panel while moving
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
            const snapped = Geometry.snapToObjects(x, y, state.objects, state.scale, [obj]);

            // Check if object snapping occurred
            if (snapped.x !== x || snapped.y !== y) {
                x = snapped.x;
                y = snapped.y;
            } else {
                // Apply angle snapping relative to the fixed point
                let fixedX, fixedY;
                if (state.resizeHandle === 'start') {
                    fixedX = obj.x2;
                    fixedY = obj.y2;
                } else {
                    fixedX = obj.x1;
                    fixedY = obj.y1;
                }

                const dx = x - fixedX;
                const dy = y - fixedY;
                const angle = Math.atan2(dy, dx);
                const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
                const dist = Math.hypot(dx, dy);

                x = fixedX + Math.cos(snappedAngle) * dist;
                y = fixedY + Math.sin(snappedAngle) * dist;
            }
        }

        const snapX = Geometry.getAxisSnap(x, 'x', state.objects, [obj], state.scale);
        const snapY = Geometry.getAxisSnap(y, 'y', state.objects, [obj], state.scale);
        if (snapX !== null) x = snapX;
        if (snapY !== null) y = snapY;

        if (state.resizeHandle === 'start') {
            obj.x1 = x;
            obj.y1 = y;
        } else if (state.resizeHandle === 'end') {
            obj.x2 = x;
            obj.y2 = y;
        }
        updatePropertyPanel(); // Update panel while resizing
        draw();
        return;
    }

    if (!state.isDragging) return;

    // Apply snapping for preview
    if (!isSnapDisabled) {
        const snapped = Geometry.snapToObjects(x, y, state.objects, state.scale);
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

window.addEventListener('mouseup', (e) => {
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
        // Check for splitting
        checkAndMergeWalls();
        if (state.selection.length === 1) {
            checkAndSplitObjects(state.selection[0]);
        }

        saveToHistory();
        state.isMoving = false;
        state.lastMousePos = null;
        return;
    }

    state.isPotentialMove = false;

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
        const snapped = Geometry.snapToObjects(x, y, state.objects, state.scale);
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

    const typeDefaults = getTypeDefaults(state.mode);
    const newObj = {
        type: state.mode,
        subtype: state.mode === 'door' ? 'single' : null, // Default to single
        isOpen: false, // Default closed
        x1: state.dragStart.x,
        y1: state.dragStart.y,
        x2: endX,
        y2: endY,
        width: typeDefaults.width,
        height: typeDefaults.height,
        color: typeDefaults.color,
    };
    state.objects.push(newObj);

    // Check for splitting
    checkAndSplitObjects(newObj);

    saveToHistory(); // Save after creating a new object;
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
function draw() {
    // clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(state.offsetX, state.offsetY);
    ctx.scale(state.scale, state.scale);

    // draw grid
    drawGrid();
    // draw objects
    // draw objects
    state.objects.forEach(obj => {
        const typeDefaults = getTypeDefaults(obj.type);
        const strokeColor = obj.color || typeDefaults.color;
        const lineWidth = Math.max(obj.width ?? typeDefaults.width, 0.5);

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineWidth / state.scale; // Keep outline width constant visually

        if (obj.type === 'door') {
            drawDoor(obj);
        } else {
            ctx.beginPath();
            ctx.moveTo(obj.x1, obj.y1);
            ctx.lineTo(obj.x2, obj.y2);
            ctx.stroke();
        }
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
    History.pushSnapshot(state);
    updateToolbar();
}

function undo() {
    if (History.undo(state)) {
        draw();
        updateToolbar();
    }
}

function redo() {
    if (History.redo(state)) {
        draw();
        updateToolbar();
    }
}

function deleteSelected() {
    if (state.selection.length > 0) {
        state.objects = state.objects.filter(obj => !state.selection.includes(obj));
        state.selection = [];

        // Check for merging (healing) walls after deletion
        checkAndMergeWalls();

        saveToHistory();
        draw();
        updateToolbar();
    }
}

// ==== Context Menu Actions ====
function showContextMenu(x, y) {
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.classList.remove('hidden');
}

function hideContextMenu() {
    contextMenu.classList.add('hidden');
}

function updateContextMenuState() {
    const hasSelection = state.selection.length > 0;
    menuCopy.disabled = !hasSelection;
    menuDelete.disabled = !hasSelection;
    menuFlipH.disabled = !hasSelection;
    menuFlipV.disabled = !hasSelection;
    menuPaste.disabled = state.clipboard.length === 0;
}

function copySelection() {
    if (state.selection.length === 0) return;
    state.clipboard = state.selection.map(obj => JSON.parse(JSON.stringify(obj)));
}

function pasteClipboard() {
    if (state.clipboard.length === 0) return;
    const clones = state.clipboard.map(obj => JSON.parse(JSON.stringify(obj)));

    // 將貼上中心對齊到最後一次開啟選單的位置，並稍微偏移避免重疊
    let target = state.lastContextWorld || { x: 0, y: 0 };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    clones.forEach(obj => {
        minX = Math.min(minX, obj.x1, obj.x2);
        minY = Math.min(minY, obj.y1, obj.y2);
        maxX = Math.max(maxX, obj.x1, obj.x2);
        maxY = Math.max(maxY, obj.y1, obj.y2);
    });
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const offset = 20 / state.scale;
    const dx = target.x - centerX + offset;
    const dy = target.y - centerY + offset;

    clones.forEach(obj => {
        obj.x1 += dx;
        obj.y1 += dy;
        obj.x2 += dx;
        obj.y2 += dy;
    });

    state.objects.push(...clones);
    state.selection = clones;
    saveToHistory();
    draw();
    updateToolbar();
}

function flipSelection(axis) {
    if (state.selection.length === 0) return;

    // 若有右鍵位置，使用該點當翻轉軸，否則用選取區中心
    let anchor = state.lastContextWorld;
    if (!anchor) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        state.selection.forEach(obj => {
            minX = Math.min(minX, obj.x1, obj.x2);
            minY = Math.min(minY, obj.y1, obj.y2);
            maxX = Math.max(maxX, obj.x1, obj.x2);
            maxY = Math.max(maxY, obj.y1, obj.y2);
        });
        anchor = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    }

    state.selection.forEach(obj => {
        if (axis === 'horizontal') {
            obj.x1 = 2 * anchor.x - obj.x1;
            obj.x2 = 2 * anchor.x - obj.x2;
        } else if (axis === 'vertical') {
            obj.y1 = 2 * anchor.y - obj.y1;
            obj.y2 = 2 * anchor.y - obj.y2;
        }
    });

    saveToHistory();
    draw();
    updateToolbar();
}



function drawDoor(obj) {
    const dx = obj.x2 - obj.x1;
    const dy = obj.y2 - obj.y1;
    const length = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    ctx.save();
    ctx.translate(obj.x1, obj.y1);
    ctx.rotate(angle);

    // Draw door frame (line)
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(length, 0);
    ctx.stroke();

    // Draw door swing based on subtype
    ctx.lineWidth = 1 / state.scale;
    ctx.beginPath();

    if (obj.subtype === 'double') {
        // Double door: two leaves meeting in center
        const leafLen = length / 2;
        // Left leaf
        ctx.moveTo(0, 0);
        ctx.lineTo(0, leafLen);
        ctx.arc(0, 0, leafLen, 0, Math.PI / 2);
        // Right leaf
        ctx.moveTo(length, 0);
        ctx.lineTo(length, leafLen);
        ctx.arc(length, 0, leafLen, Math.PI, Math.PI / 2, true);
    } else if (obj.subtype === 'mother-son') {
        // Mother-Son: unequal leaves (e.g. 70/30)
        const bigLen = length * 0.7;
        const smallLen = length * 0.3;
        // Big leaf (left)
        ctx.moveTo(0, 0);
        ctx.lineTo(0, bigLen);
        ctx.arc(0, 0, bigLen, 0, Math.PI / 2);
        // Small leaf (right)
        ctx.moveTo(length, 0);
        ctx.lineTo(length, smallLen);
        ctx.arc(length, 0, smallLen, Math.PI, Math.PI / 2, true);
    } else {
        // Single door (default)
        ctx.moveTo(0, 0);
        ctx.lineTo(0, length);
        ctx.arc(0, 0, length, 0, Math.PI / 2);
    }

    ctx.stroke();
    ctx.restore();
}

function getColorForType(type) {
    return TYPE_DEFAULTS[type]?.color || '#ffffff';
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
        const defaults = getTypeDefaults(obj.type);
        const height = obj.height ?? defaults.height;
        const thickness = obj.width ?? defaults.width;
        const color = obj.color || defaults.color;

        // position at midpoint
        const midX = (obj.x1 + obj.x2) / 2 - canvas.width / 2;
        const midY = (obj.y1 + obj.y2) / 2 - canvas.height / 2;
        const angle = Math.atan2(obj.y2 - obj.y1, obj.x2 - obj.x1);

        if (obj.type === 'door') {
            const mat = new THREE.MeshStandardMaterial({
                color: getThreeColor(obj),
                roughness: 0.7,
                metalness: 0.3
            });

            // Create a pivot group for the door to handle rotation
            const doorGroup = new THREE.Group();
            doorGroup.position.set(midX, 0, midY);
            doorGroup.rotation.y = -angle;
            previewScene.add(doorGroup);

            if (obj.subtype === 'double') {
                const leafLen = length / 2;

                // Left leaf group (pivot at left edge)
                const leftGroup = new THREE.Group();
                leftGroup.position.set(-length / 2, 0, 0); // Pivot at left end
                if (obj.isOpen) leftGroup.rotation.y = -Math.PI / 2; // Open outwards/inwards

                const g1 = new THREE.BoxGeometry(leafLen, height, thickness);
                const m1 = new THREE.Mesh(g1, mat);
                m1.position.set(leafLen / 2, height / 2, 0); // Center mesh relative to pivot
                leftGroup.add(m1);
                doorGroup.add(leftGroup);

                // Right leaf group (pivot at right edge)
                const rightGroup = new THREE.Group();
                rightGroup.position.set(length / 2, 0, 0); // Pivot at right end
                if (obj.isOpen) rightGroup.rotation.y = Math.PI / 2;

                const m2 = new THREE.Mesh(g1, mat);
                m2.position.set(-leafLen / 2, height / 2, 0); // Center mesh relative to pivot
                rightGroup.add(m2);
                doorGroup.add(rightGroup);

            } else if (obj.subtype === 'mother-son') {
                const bigLen = length * 0.7;
                const smallLen = length * 0.3;

                // Big leaf (left)
                const leftGroup = new THREE.Group();
                leftGroup.position.set(-length / 2, 0, 0);
                if (obj.isOpen) leftGroup.rotation.y = -Math.PI / 2;

                const g1 = new THREE.BoxGeometry(bigLen, height, thickness);
                const m1 = new THREE.Mesh(g1, mat);
                m1.position.set(bigLen / 2, height / 2, 0);
                leftGroup.add(m1);
                doorGroup.add(leftGroup);

                // Small leaf (right)
                const rightGroup = new THREE.Group();
                rightGroup.position.set(length / 2, 0, 0);
                if (obj.isOpen) rightGroup.rotation.y = Math.PI / 2;

                const g2 = new THREE.BoxGeometry(smallLen, height, thickness);
                const m2 = new THREE.Mesh(g2, mat);
                m2.position.set(-smallLen / 2, height / 2, 0);
                rightGroup.add(m2);
                doorGroup.add(rightGroup);
            } else {
                // Single
                const pivotGroup = new THREE.Group();
                pivotGroup.position.set(-length / 2, 0, 0); // Pivot at left end (start point)
                if (obj.isOpen) pivotGroup.rotation.y = -Math.PI / 2;

                const geometry = new THREE.BoxGeometry(length, height, thickness);
                const mesh = new THREE.Mesh(geometry, mat);
                mesh.position.set(length / 2, height / 2, 0); // Center mesh relative to pivot
                pivotGroup.add(mesh);
                doorGroup.add(pivotGroup);
            }
        } else {
            // Wall, Window, Furniture
            const geometry = new THREE.BoxGeometry(length, height, thickness);
            const material = new THREE.MeshStandardMaterial({
                color: getThreeColor(obj),
                roughness: 0.7,
                metalness: 0.3
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.position.set(midX, height / 2, midY);
            mesh.rotation.y = -angle;
            previewScene.add(mesh);
        }
    });
}

function togglePropertyPanel() {
    state.showPropertyPanel = !state.showPropertyPanel;
    const panel = document.getElementById('property-panel');
    const btn = document.getElementById('toggle-properties');

    if (state.showPropertyPanel) {
        panel.classList.remove('hidden');
        btn.classList.add('active');
        updatePropertyPanel();
    } else {
        panel.classList.add('hidden');
        btn.classList.remove('active');
    }
}

function updatePropertyPanel() {
    if (!state.showPropertyPanel) return;

    const panel = document.getElementById('property-panel');
    const doorSection = document.getElementById('prop-door-section');
    const widthInput = document.getElementById('prop-width');
    const heightInput = document.getElementById('prop-height');
    const colorInput = document.getElementById('prop-color');

    if (state.selection.length !== 1) {
        // Clear inputs or show "No selection" / "Multiple selection"
        // For now, just hide the content or disable inputs could be better, 
        // but let's just keep the panel visible but maybe empty or default
        // Actually, hiding the panel content or showing a message is better
        // But per requirement "when property window is open AND object selected"
        // We can just clear values
        document.getElementById('prop-x').value = '';
        document.getElementById('prop-y').value = '';
        document.getElementById('prop-length').value = '';
        document.getElementById('prop-angle').value = '';
        doorSection.classList.add('hidden');
        widthInput.value = '';
        heightInput.value = '';
        colorInput.value = '#ffffff';
        return;
    }

    const obj = state.selection[0];

    // Calculate properties
    const midX = (obj.x1 + obj.x2) / 2;
    const midY = (obj.y1 + obj.y2) / 2;
    const dx = obj.x2 - obj.x1;
    const dy = obj.y2 - obj.y1;
    const length = Math.hypot(dx, dy);
    let angle = Math.atan2(dy, dx) * (180 / Math.PI); // Convert to degrees
    if (angle < 0) angle += 360;

    // Update inputs
    if (document.activeElement.id !== 'prop-x') document.getElementById('prop-x').value = Math.round(midX);
    if (document.activeElement.id !== 'prop-y') document.getElementById('prop-y').value = Math.round(midY);
    if (document.activeElement.id !== 'prop-length') document.getElementById('prop-length').value = Math.round(length);
    if (document.activeElement.id !== 'prop-angle') document.getElementById('prop-angle').value = Math.round(angle);
    const typeDefaults = getTypeDefaults(obj.type);
    const widthValue = obj.width ?? typeDefaults.width;
    const heightValue = obj.height ?? typeDefaults.height;
    const colorValue = normalizeColor(obj.color || typeDefaults.color);

    if (document.activeElement.id !== 'prop-width') widthInput.value = Math.round(widthValue);
    if (document.activeElement.id !== 'prop-height') heightInput.value = Math.round(heightValue);
    colorInput.value = colorValue;

    // Door specific
    if (obj.type === 'door') {
        doorSection.classList.remove('hidden');
        document.getElementById('prop-door-type').value = obj.subtype || 'single';
        document.getElementById('prop-door-open').checked = !!obj.isOpen;
    } else {
        doorSection.classList.add('hidden');
    }
}

function applyPropertyChange(prop, value) {
    if (state.selection.length !== 1) return;
    const obj = state.selection[0];

    if (prop === 'x' || prop === 'y') {
        const midX = (obj.x1 + obj.x2) / 2;
        const midY = (obj.y1 + obj.y2) / 2;
        const dx = prop === 'x' ? value - midX : 0;
        const dy = prop === 'y' ? value - midY : 0;

        obj.x1 += dx;
        obj.x2 += dx;
        obj.y1 += dy;
        obj.y2 += dy;
    } else if (prop === 'length') {
        const currentLen = Math.hypot(obj.x2 - obj.x1, obj.y2 - obj.y1);
        if (currentLen === 0) return;
        const scale = value / currentLen;
        const midX = (obj.x1 + obj.x2) / 2;
        const midY = (obj.y1 + obj.y2) / 2;

        // Scale around center
        obj.x1 = midX + (obj.x1 - midX) * scale;
        obj.y1 = midY + (obj.y1 - midY) * scale;
        obj.x2 = midX + (obj.x2 - midX) * scale;
        obj.y2 = midY + (obj.y2 - midY) * scale;
    } else if (prop === 'angle') {
        const rad = value * (Math.PI / 180);
        const currentLen = Math.hypot(obj.x2 - obj.x1, obj.y2 - obj.y1);
        const midX = (obj.x1 + obj.x2) / 2;
        const midY = (obj.y1 + obj.y2) / 2;

        obj.x1 = midX - (Math.cos(rad) * currentLen / 2);
        obj.y1 = midY - (Math.sin(rad) * currentLen / 2);
        obj.x2 = midX + (Math.cos(rad) * currentLen / 2);
        obj.y2 = midY + (Math.sin(rad) * currentLen / 2);
    } else if (prop === 'subtype') {
        obj.subtype = value;
    } else if (prop === 'isOpen') {
        obj.isOpen = value;
    } else if (prop === 'width') {
        if (!Number.isNaN(value) && value > 0) obj.width = value;
    } else if (prop === 'height') {
        if (!Number.isNaN(value) && value > 0) obj.height = value;
    } else if (prop === 'color') {
        obj.color = normalizeColor(value);
    }

    saveToHistory();
    draw();
    updatePropertyPanel();
}

function normalizeColor(value) {
    if (typeof value !== 'string') return '#ffffff';
    if (!value.startsWith('#')) return '#ffffff';
    if (value.length === 7) return value.toLowerCase();
    if (value.length === 4) {
        const expand = (char) => `${char}${char}`;
        const r = expand(value[1]);
        const g = expand(value[2]);
        const b = expand(value[3]);
        return `#${r}${g}${b}`.toLowerCase();
    }
    return '#ffffff';
}

// ==== Object Splitting Logic ====
function checkAndSplitObjects(activeObj) {
    const newObjects = [];
    let splitOccurred = false;

    state.objects.forEach(otherObj => {
        if (otherObj === activeObj) return;
        if (otherObj.type !== 'wall') return;

        if (!Geometry.areSegmentsCollinear(otherObj, activeObj)) return;
        if (!Geometry.isSegmentContained(activeObj, otherObj)) return;

        splitOccurred = true;

        const dX = otherObj.x2 - otherObj.x1;
        const dY = otherObj.y2 - otherObj.y1;
        const wallLenSq = dX * dX + dY * dY;

        const t1 = ((activeObj.x1 - otherObj.x1) * dX + (activeObj.y1 - otherObj.y1) * dY) / wallLenSq;
        const t2 = ((activeObj.x2 - otherObj.x1) * dX + (activeObj.y2 - otherObj.y1) * dY) / wallLenSq;

        const tStart = Math.min(t1, t2);
        const tEnd = Math.max(t1, t2);

        const splitStart = {
            x: otherObj.x1 + tStart * dX,
            y: otherObj.y1 + tStart * dY
        };

        const splitEnd = {
            x: otherObj.x1 + tEnd * dX,
            y: otherObj.y1 + tEnd * dY
        };

        const originalEnd = { x: otherObj.x2, y: otherObj.y2 };

        const segment2 = {
            ...otherObj,
            x1: splitEnd.x,
            y1: splitEnd.y,
            x2: originalEnd.x,
            y2: originalEnd.y
        };

        otherObj.x2 = splitStart.x;
        otherObj.y2 = splitStart.y;

        newObjects.push(segment2);
    });

    if (splitOccurred) {
        state.objects.push(...newObjects);
    }

    return splitOccurred;
}

function checkAndMergeWalls() {
    let merged = false;
    do {
        merged = false;
        const walls = state.objects.filter(o => o.type === 'wall');

        for (let i = 0; i < walls.length; i++) {
            for (let j = i + 1; j < walls.length; j++) {
                const w1 = walls[i];
                const w2 = walls[j];

                if (!Geometry.areSegmentsCollinear(w1, w2)) continue;

                const closest = Geometry.getClosestEndpoints(w1, w2);
                if (!closest) continue;

                const gapSegment = { x1: closest.p1.x, y1: closest.p1.y, x2: closest.p2.x, y2: closest.p2.y };

                // Keep merges local so distant collinear walls are not fused accidentally
                if (closest.distance > 150 / state.scale) continue;

                if (Geometry.isGapBlocked(gapSegment, w1, w2, state.objects)) continue;

                const mergedSegment = Geometry.getCombinedSegment(w1, w2);
                if (!mergedSegment) continue;

                state.objects = state.objects.filter(o => o !== w1 && o !== w2);
                const mergedObj = {
                    ...w1,
                    x1: mergedSegment.start.x,
                    y1: mergedSegment.start.y,
                    x2: mergedSegment.end.x,
                    y2: mergedSegment.end.y
                };
                state.objects.push(mergedObj);
                if (state.selection.includes(w1) || state.selection.includes(w2)) {
                    state.selection = [mergedObj];
                }

                merged = true;
                break;
            }
            if (merged) break;
        }
    } while (merged);
}

function getThreeColor(obj) {
    const color = obj?.color || getColorForType(obj?.type);
    return new THREE.Color(color);
}

function renderThree() {
    if (!previewRenderer) return;
    orbitControls.update();
    previewRenderer.render(previewScene, previewCamera);
    requestAnimationFrame(renderThree);
}

// Initial draw
draw();
