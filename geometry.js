// geometry.js - shared geometric helpers and snapping

function pointToLineDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return Infinity;
    return Math.abs((px - x1) * dy - (py - y1) * dx) / len;
}

export function closestPointOnSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) {
        return { x: x1, y: y1, dist: Math.hypot(px - x1, py - y1) };
    }

    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    return { x: cx, y: cy, dist: Math.hypot(px - cx, py - cy) };
}

export function snapToObjects(x, y, objects, scale, excludeObjects = []) {
    const snapThreshold = 15 / scale;
    let snappedX = x;
    let snappedY = y;
    let minDist = snapThreshold;

    const consider = (px, py, dist) => {
        if (dist < minDist) {
            minDist = dist;
            snappedX = px;
            snappedY = py;
        }
    };

    objects.forEach(obj => {
        if (excludeObjects.includes(obj)) return;

        // Endpoints
        consider(obj.x1, obj.y1, Math.hypot(x - obj.x1, y - obj.y1));
        consider(obj.x2, obj.y2, Math.hypot(x - obj.x2, y - obj.y2));

        // Any point along the segment
        const snap = closestPointOnSegment(x, y, obj.x1, obj.y1, obj.x2, obj.y2);
        consider(snap.x, snap.y, snap.dist);
    });

    return { x: snappedX, y: snappedY };
}

export function getMoveSnapCorrection(dx, dy, selection, objects, scale) {
    const snapThreshold = 15 / scale;
    let correctionX = 0;
    let correctionY = 0;
    let minDist = snapThreshold;

    const unselected = objects.filter(obj => !selection.includes(obj));
    if (unselected.length === 0) return { x: 0, y: 0 };

    for (const selObj of selection) {
        const p1x = selObj.x1 + dx;
        const p1y = selObj.y1 + dy;
        const p2x = selObj.x2 + dx;
        const p2y = selObj.y2 + dy;

        for (const target of unselected) {
            const snapP1 = closestPointOnSegment(p1x, p1y, target.x1, target.y1, target.x2, target.y2);
            if (snapP1.dist < minDist) {
                minDist = snapP1.dist;
                correctionX = snapP1.x - p1x;
                correctionY = snapP1.y - p1y;
            }

            const snapP2 = closestPointOnSegment(p2x, p2y, target.x1, target.y1, target.x2, target.y2);
            if (snapP2.dist < minDist) {
                minDist = snapP2.dist;
                correctionX = snapP2.x - p2x;
                correctionY = snapP2.y - p2y;
            }
        }
    }

    const selectionBounds = getSelectionBounds(selection);
    const alignment = getAlignmentCorrection(selectionBounds, dx, dy, unselected, scale);
    if (alignment.x !== 0 && (correctionX === 0 || Math.abs(alignment.x) < Math.abs(correctionX))) {
        correctionX = alignment.x;
    }
    if (alignment.y !== 0 && (correctionY === 0 || Math.abs(alignment.y) < Math.abs(correctionY))) {
        correctionY = alignment.y;
    }

    return { x: correctionX, y: correctionY };
}

export function getBounds(obj) {
    if (!obj) return null;
    const left = Math.min(obj.x1, obj.x2);
    const right = Math.max(obj.x1, obj.x2);
    const top = Math.min(obj.y1, obj.y2);
    const bottom = Math.max(obj.y1, obj.y2);
    return {
        left,
        right,
        top,
        bottom,
        centerX: (left + right) / 2,
        centerY: (top + bottom) / 2
    };
}

export function getSelectionBounds(selection) {
    if (!selection || selection.length === 0) return null;
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    selection.forEach(obj => {
        left = Math.min(left, obj.x1, obj.x2);
        right = Math.max(right, obj.x1, obj.x2);
        top = Math.min(top, obj.y1, obj.y2);
        bottom = Math.max(bottom, obj.y1, obj.y2);
    });
    return {
        left,
        right,
        top,
        bottom,
        centerX: (left + right) / 2,
        centerY: (top + bottom) / 2
    };
}

function axisDistance(low1, high1, low2, high2) {
    if (high1 < low2) return low2 - high1;
    if (high2 < low1) return low1 - high2;
    return 0;
}

export function getAlignmentCorrection(selectionBounds, dx, dy, targets, scale) {
    if (!selectionBounds || !targets || targets.length === 0) return { x: 0, y: 0 };

    const threshold = 40 / scale;
    const moved = {
        left: selectionBounds.left + dx,
        right: selectionBounds.right + dx,
        top: selectionBounds.top + dy,
        bottom: selectionBounds.bottom + dy,
        centerX: selectionBounds.centerX + dx,
        centerY: selectionBounds.centerY + dy
    };

    const selectionX = [moved.left, moved.centerX, moved.right];
    const selectionY = [moved.top, moved.centerY, moved.bottom];

    let bestX = { dist: threshold, value: 0 };
    let bestY = { dist: threshold, value: 0 };

    targets.forEach(target => {
        const targetBounds = getBounds(target);
        if (!targetBounds) return;

        const targetXs = [targetBounds.left, targetBounds.centerX, targetBounds.right];
        const targetYs = [targetBounds.top, targetBounds.centerY, targetBounds.bottom];

        selectionX.forEach(selX => {
            targetXs.forEach(tx => {
                const deltaX = tx - selX;
                if (Math.abs(deltaX) < bestX.dist) {
                    bestX = { dist: Math.abs(deltaX), value: deltaX };
                }
            });
        });

        selectionY.forEach(selY => {
            targetYs.forEach(ty => {
                const deltaY = ty - selY;
                if (Math.abs(deltaY) < bestY.dist) {
                    bestY = { dist: Math.abs(deltaY), value: deltaY };
                }
            });
        });
    });

    return { x: bestX.value, y: bestY.value };
}

export function getAxisSnap(value, axis, objects, exclude = [], scale = 1) {
    const threshold = 12 / scale;
    let best = { dist: threshold, value: null };
    objects.forEach(obj => {
        if (exclude.includes(obj)) return;
        const bounds = getBounds(obj);
        if (!bounds) return;
        const candidates = axis === 'x'
            ? [bounds.left, bounds.centerX, bounds.right]
            : [bounds.top, bounds.centerY, bounds.bottom];
        candidates.forEach(candidate => {
            const dist = Math.abs(candidate - value);
            if (dist < best.dist) {
                best = { dist, value: candidate };
            }
        });
    });
    return best.value !== null ? best.value : null;
}

export function areSegmentsCollinear(segA, segB, tolerance = 6) {
    if (!segA || !segB) return false;
    return (
        pointToLineDistance(segB.x1, segB.y1, segA.x1, segA.y1, segA.x2, segA.y2) < tolerance &&
        pointToLineDistance(segB.x2, segB.y2, segA.x1, segA.y1, segA.x2, segA.y2) < tolerance
    );
}

export function isSegmentContained(inner, outer, epsilon = 0.01) {
    const dx = outer.x2 - outer.x1;
    const dy = outer.y2 - outer.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) return false;

    const t1 = ((inner.x1 - outer.x1) * dx + (inner.y1 - outer.y1) * dy) / lenSq;
    const t2 = ((inner.x2 - outer.x1) * dx + (inner.y2 - outer.y1) * dy) / lenSq;

    const minT = Math.min(t1, t2);
    const maxT = Math.max(t1, t2);

    return minT > epsilon && maxT < (1 - epsilon);
}

export function segmentsOverlap(segA, segB, epsilon = 0.01) {
    const dx = segA.x2 - segA.x1;
    const dy = segA.y2 - segA.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) return false;

    const proj = (pt) => ((pt.x - segA.x1) * dx + (pt.y - segA.y1) * dy) / lenSq;

    const aMin = 0;
    const aMax = 1;
    const b1 = proj({ x: segB.x1, y: segB.y1 });
    const b2 = proj({ x: segB.x2, y: segB.y2 });
    const bMin = Math.min(b1, b2);
    const bMax = Math.max(b1, b2);

    return !(bMax < aMin - epsilon || bMin > aMax + epsilon);
}

export function getClosestEndpoints(segA, segB) {
    const endpointsA = [{ x: segA.x1, y: segA.y1 }, { x: segA.x2, y: segA.y2 }];
    const endpointsB = [{ x: segB.x1, y: segB.y1 }, { x: segB.x2, y: segB.y2 }];

    let best = null;

    endpointsA.forEach(p1 => {
        endpointsB.forEach(p2 => {
            const distance = Math.hypot(p1.x - p2.x, p1.y - p2.y);
            if (!best || distance < best.distance) {
                best = { p1, p2, distance };
            }
        });
    });

    return best;
}

export function getCombinedSegment(segA, segB) {
    const dx = segA.x2 - segA.x1;
    const dy = segA.y2 - segA.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) return null;

    const project = (pt) => ((pt.x - segA.x1) * dx + (pt.y - segA.y1) * dy) / lenSq;
    const points = [
        { x: segA.x1, y: segA.y1 },
        { x: segA.x2, y: segA.y2 },
        { x: segB.x1, y: segB.y1 },
        { x: segB.x2, y: segB.y2 },
    ];

    let minT = Infinity;
    let maxT = -Infinity;

    points.forEach(pt => {
        const t = project(pt);
        if (t < minT) minT = t;
        if (t > maxT) maxT = t;
    });

    return {
        start: { x: segA.x1 + dx * minT, y: segA.y1 + dy * minT },
        end: { x: segA.x1 + dx * maxT, y: segA.y1 + dy * maxT },
    };
}

export function isGapBlocked(gapSegment, segA, segB, objects) {
    const touchTolerance = 2;
    const gapLength = Math.hypot(gapSegment.x2 - gapSegment.x1, gapSegment.y2 - gapSegment.y1);

    return objects.some(obj => {
        if (obj === segA || obj === segB) return false;

        const touchesEndpoint =
            Math.hypot(obj.x1 - gapSegment.x1, obj.y1 - gapSegment.y1) < touchTolerance ||
            Math.hypot(obj.x2 - gapSegment.x1, obj.y2 - gapSegment.y1) < touchTolerance ||
            Math.hypot(obj.x1 - gapSegment.x2, obj.y1 - gapSegment.y2) < touchTolerance ||
            Math.hypot(obj.x2 - gapSegment.x2, obj.y2 - gapSegment.y2) < touchTolerance;

        if (touchesEndpoint) return true;
        if (gapLength < 1e-6) return false;

        if (areSegmentsCollinear(gapSegment, obj) && segmentsOverlap(gapSegment, obj, 0.001)) {
            return true;
        }

        return false;
    });
}
