// history.js - undo/redo stack for the floorplan state

function cloneObjects(objects) {
    return JSON.parse(JSON.stringify(objects));
}

export function pushSnapshot(state, limit = 50) {
    if (state.historyIndex < state.history.length - 1) {
        state.history = state.history.slice(0, state.historyIndex + 1);
    }

    state.history.push(cloneObjects(state.objects));
    state.historyIndex++;

    if (state.history.length > limit) {
        state.history.shift();
        state.historyIndex--;
    }
}

export function undo(state) {
    if (state.historyIndex > 0) {
        state.historyIndex--;
        state.objects = cloneObjects(state.history[state.historyIndex]);
        state.selection = [];
        return true;
    }
    if (state.historyIndex === 0) {
        state.historyIndex = -1;
        state.objects = [];
        state.selection = [];
        return true;
    }
    return false;
}

export function redo(state) {
    if (state.historyIndex < state.history.length - 1) {
        state.historyIndex++;
        state.objects = cloneObjects(state.history[state.historyIndex]);
        state.selection = [];
        return true;
    }
    return false;
}
