// Per-thread state type, transition functions, and selectors.
// All transitions operate on the global store from ../store.js.
//
// ThreadRunState is a value-type: one entry per active thread in the
// global store's `threads` Map. Transition functions produce new Map +
// new ThreadRunState objects each time (immutable updates).
//
// Derived helpers (queue checks) compute from state and are never
// stored — they are always re-derived from ThreadRunState.
//
// STATE DISCIPLINE: keep as little state as possible. Before adding any new
// state field, ask if it can be derived from existing state instead.
import { store } from '../store.js';
// ── Initial state factory ────────────────────────────────────────
export function initialThreadState() {
    return {
        sessionId: undefined,
        sessionUsername: undefined,
        sessionUserId: undefined,
        parentSessionId: undefined,
        queueItems: [],
        sentPartIds: new Set(),
    };
}
// ── Derived helpers (compute, never store) ───────────────────────
export function hasQueue(t) {
    return t.queueItems.length > 0;
}
// ── Pure transition helpers ──────────────────────────────────────
// Immutable: produces new Map + new ThreadRunState object each time.
export function updateThread(threadId, updater) {
    store.setState((s) => {
        const existing = s.threads.get(threadId);
        if (!existing) {
            return s;
        }
        const newThreads = new Map(s.threads);
        newThreads.set(threadId, updater(existing));
        return { threads: newThreads };
    });
}
export function ensureThread(threadId) {
    if (store.getState().threads.has(threadId)) {
        return;
    }
    store.setState((s) => {
        const newThreads = new Map(s.threads);
        newThreads.set(threadId, initialThreadState());
        return { threads: newThreads };
    });
}
export function removeThread(threadId) {
    store.setState((s) => {
        if (!s.threads.has(threadId)) {
            return s;
        }
        const newThreads = new Map(s.threads);
        newThreads.delete(threadId);
        return { threads: newThreads };
    });
}
export function setSessionId(threadId, sessionId) {
    updateThread(threadId, (t) => ({ ...t, sessionId }));
}
export function setSessionUsername(threadId, username) {
    updateThread(threadId, (t) => {
        if (t.sessionUsername) {
            return t;
        }
        return { ...t, sessionUsername: username };
    });
}
export function setSessionUserId(threadId, userId) {
    if (!userId)
        return;
    updateThread(threadId, (t) => {
        if (t.sessionUserId) {
            return t;
        }
        return { ...t, sessionUserId: userId };
    });
}
export function setParentSessionId(threadId, parentSessionId) {
    updateThread(threadId, (t) => {
        if (t.parentSessionId) {
            return t;
        }
        return { ...t, parentSessionId };
    });
}
export function enqueueItem(threadId, item) {
    updateThread(threadId, (t) => ({
        ...t,
        queueItems: [...t.queueItems, item],
    }));
}
export function replaceQueueItems(threadId, items) {
    ensureThread(threadId);
    updateThread(threadId, (t) => ({ ...t, queueItems: items }));
}
// Atomic dequeue: read + write in one setState call to prevent
// a concurrent enqueue between read and write from losing items.
export function dequeueItem(threadId) {
    let next;
    store.setState((s) => {
        const t = s.threads.get(threadId);
        if (!t || t.queueItems.length === 0) {
            return s;
        }
        const [head, ...rest] = t.queueItems;
        next = head;
        const newThreads = new Map(s.threads);
        newThreads.set(threadId, { ...t, queueItems: rest });
        return { threads: newThreads };
    });
    return next;
}
export function clearQueueItems(threadId) {
    const items = store.getState().threads.get(threadId)?.queueItems.slice() ?? [];
    updateThread(threadId, (t) => ({ ...t, queueItems: [] }));
    return items;
}
export function removeQueueItemAtPosition(threadId, position) {
    if (position < 1) {
        return undefined;
    }
    let removedItem;
    store.setState((s) => {
        const t = s.threads.get(threadId);
        if (!t) {
            return s;
        }
        const index = position - 1;
        const removed = t.queueItems[index];
        if (!removed) {
            return s;
        }
        removedItem = removed;
        const newThreads = new Map(s.threads);
        newThreads.set(threadId, {
            ...t,
            queueItems: t.queueItems.filter((_, itemIndex) => {
                return itemIndex !== index;
            }),
        });
        return { threads: newThreads };
    });
    return removedItem;
}
export function removeQueueItemById(threadId, queueId) {
    if (!queueId) {
        return undefined;
    }
    let removedItem;
    store.setState((s) => {
        const t = s.threads.get(threadId);
        if (!t) {
            return s;
        }
        const index = t.queueItems.findIndex((item) => item.queueId === queueId);
        if (index === -1) {
            return s;
        }
        removedItem = t.queueItems[index];
        const newThreads = new Map(s.threads);
        newThreads.set(threadId, {
            ...t,
            queueItems: t.queueItems.filter((_, itemIndex) => itemIndex !== index),
        });
        return { threads: newThreads };
    });
    return removedItem;
}
/**
 * Find a queued item by its Discord source message ID and apply an updater.
 * If the updater returns null, the item is removed from the queue.
 * Returns the original (pre-update) item, or undefined if not found.
 */
export function updateQueueItemBySourceMessageId(threadId, sourceMessageId, updater) {
    let originalItem;
    store.setState((s) => {
        const t = s.threads.get(threadId);
        if (!t)
            return s;
        const index = t.queueItems.findIndex((item) => {
            return item.sourceMessageId === sourceMessageId;
        });
        if (index === -1)
            return s;
        originalItem = t.queueItems[index];
        const updated = updater(originalItem);
        const newThreads = new Map(s.threads);
        newThreads.set(threadId, {
            ...t,
            queueItems: updated === null
                ? t.queueItems.filter((_, i) => i !== index)
                : t.queueItems.map((item, i) => (i === index ? updated : item)),
        });
        return { threads: newThreads };
    });
    return originalItem;
}
// ── Queries ──────────────────────────────────────────────────────
export function getThreadState(threadId) {
    return store.getState().threads.get(threadId);
}
export function getThreadIds() {
    return [...store.getState().threads.keys()];
}
