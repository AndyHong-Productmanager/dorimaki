// SQLite database manager for persistent bot state using Drizzle.
// Stores thread-session mappings, bot tokens, channel directories,
// API keys, and model preferences in <dataDir>/discord-sessions.db.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as errore from 'errore';
import * as orm from 'drizzle-orm';
import { getDb, closeDb } from './db.js';
import { createLogger, LogPrefix } from './logger.js';
import * as schema from './schema.js';
import { store } from './store.js';
const dbLogger = createLogger(LogPrefix.DB);
export { getDb, closeDb };
export async function initDatabase() {
    const db = await getDb();
    dbLogger.log('Database initialized');
    return db;
}
export const closeDatabase = closeDb;
function countRows(rows) {
    return rows.length;
}
export async function createScheduledTask({ scheduleKind, runAt, cronExpr, timezone, nextRunAt, payloadJson, promptPreview, channelId, threadId, sessionId, projectDirectory, }) {
    const db = await getDb();
    const [row] = await db.insert(schema.scheduled_tasks).values({
        status: 'planned',
        schedule_kind: scheduleKind,
        run_at: runAt ?? null,
        cron_expr: cronExpr ?? null,
        timezone: timezone ?? null,
        next_run_at: nextRunAt,
        payload_json: payloadJson,
        prompt_preview: promptPreview,
        channel_id: channelId ?? null,
        thread_id: threadId ?? null,
        session_id: sessionId ?? null,
        project_directory: projectDirectory ?? null,
    }).returning({ id: schema.scheduled_tasks.id });
    if (!row)
        throw new Error('Failed to create scheduled task');
    return row.id;
}
export async function listScheduledTasks({ statuses, } = {}) {
    const db = await getDb();
    return db.query.scheduled_tasks.findMany({
        where: statuses && statuses.length > 0 ? { status: { in: statuses } } : undefined,
        orderBy: { next_run_at: 'asc', id: 'asc' },
    });
}
export async function getScheduledTask(taskId) {
    const db = await getDb();
    return await db.query.scheduled_tasks.findFirst({ where: { id: taskId } }) ?? null;
}
export async function updateScheduledTask({ taskId, payloadJson, promptPreview, scheduleKind, runAt, cronExpr, timezone, nextRunAt, }) {
    const db = await getDb();
    const data = {
        payload_json: payloadJson,
        prompt_preview: promptPreview,
    };
    if (scheduleKind !== undefined)
        data.schedule_kind = scheduleKind;
    if (runAt !== undefined)
        data.run_at = runAt;
    if (cronExpr !== undefined)
        data.cron_expr = cronExpr;
    if (timezone !== undefined)
        data.timezone = timezone;
    if (nextRunAt !== undefined)
        data.next_run_at = nextRunAt;
    const rows = await db.update(schema.scheduled_tasks)
        .set(data)
        .where(orm.and(orm.eq(schema.scheduled_tasks.id, taskId), orm.eq(schema.scheduled_tasks.status, 'planned')))
        .returning({ id: schema.scheduled_tasks.id });
    return countRows(rows) > 0;
}
export async function cancelScheduledTask(taskId) {
    const db = await getDb();
    const rows = await db.update(schema.scheduled_tasks)
        .set({ status: 'cancelled', running_started_at: null })
        .where(orm.and(orm.eq(schema.scheduled_tasks.id, taskId), orm.inArray(schema.scheduled_tasks.status, ['planned', 'running'])))
        .returning({ id: schema.scheduled_tasks.id });
    return countRows(rows) > 0;
}
export async function getDuePlannedScheduledTasks({ now, limit }) {
    const db = await getDb();
    return db.query.scheduled_tasks.findMany({
        where: { status: 'planned', next_run_at: { lte: now } },
        orderBy: { next_run_at: 'asc', id: 'asc' },
        limit,
    });
}
export async function claimScheduledTaskRunning({ taskId, startedAt }) {
    const db = await getDb();
    const rows = await db.update(schema.scheduled_tasks)
        .set({ status: 'running', running_started_at: startedAt })
        .where(orm.and(orm.eq(schema.scheduled_tasks.id, taskId), orm.eq(schema.scheduled_tasks.status, 'planned')))
        .returning({ id: schema.scheduled_tasks.id });
    return countRows(rows) > 0;
}
export async function releaseScheduledTaskClaim(taskId) {
    const db = await getDb();
    await db.update(schema.scheduled_tasks)
        .set({ status: 'planned', running_started_at: null })
        .where(orm.and(orm.eq(schema.scheduled_tasks.id, taskId), orm.eq(schema.scheduled_tasks.status, 'running')));
}
export async function createScheduledTaskRun({ taskId, startedAt, }) {
    const db = await getDb();
    const [run] = await db.insert(schema.scheduled_task_runs)
        .values({ scheduled_task_id: taskId, started_at: startedAt })
        .returning({ id: schema.scheduled_task_runs.id });
    if (!run)
        throw new Error(`Failed to create run for scheduled task ${taskId}`);
    return run.id;
}
export async function getActiveScheduledTaskRuns(taskId) {
    const db = await getDb();
    return db.query.scheduled_task_runs.findMany({
        where: {
            scheduled_task_id: taskId,
            status: { in: ['pending', 'running'] },
        },
        orderBy: { started_at: 'desc' },
    });
}
export async function setScheduledTaskRunThread({ runId, threadId, }) {
    const db = await getDb();
    await db.update(schema.scheduled_task_runs)
        .set({ thread_id: threadId })
        .where(orm.eq(schema.scheduled_task_runs.id, runId));
}
export async function startScheduledTaskRunSession({ runId, sessionId, projectDirectory, }) {
    const db = await getDb();
    await db.update(schema.scheduled_task_runs)
        .set({ status: 'running', session_id: sessionId, project_directory: projectDirectory })
        .where(orm.and(orm.eq(schema.scheduled_task_runs.id, runId), orm.eq(schema.scheduled_task_runs.status, 'pending')));
}
export async function completeScheduledTaskRunsForSession(sessionId) {
    const db = await getDb();
    const rows = await db.update(schema.scheduled_task_runs)
        .set({ status: 'completed', completed_at: new Date() })
        .where(orm.and(orm.eq(schema.scheduled_task_runs.session_id, sessionId), orm.inArray(schema.scheduled_task_runs.status, ['pending', 'running'])))
        .returning({ id: schema.scheduled_task_runs.id });
    return rows.length;
}
export async function failScheduledTaskRunsForSession({ sessionId, error, }) {
    const db = await getDb();
    const rows = await db.update(schema.scheduled_task_runs)
        .set({ status: 'failed', completed_at: new Date(), error })
        .where(orm.and(orm.eq(schema.scheduled_task_runs.session_id, sessionId), orm.inArray(schema.scheduled_task_runs.status, ['pending', 'running'])))
        .returning({ id: schema.scheduled_task_runs.id });
    return rows.length;
}
export async function failScheduledTaskRun({ runId, error, }) {
    const db = await getDb();
    await db.update(schema.scheduled_task_runs)
        .set({ status: 'failed', completed_at: new Date(), error })
        .where(orm.eq(schema.scheduled_task_runs.id, runId));
}
export async function finishScheduledTaskRun({ runId, status, }) {
    const db = await getDb();
    await db.update(schema.scheduled_task_runs)
        .set({ status, completed_at: new Date() })
        .where(orm.eq(schema.scheduled_task_runs.id, runId));
}
export async function recoverStaleRunningScheduledTasks({ staleBefore }) {
    const db = await getDb();
    const rows = await db.update(schema.scheduled_tasks)
        .set({ status: 'planned', running_started_at: null })
        .where(orm.and(orm.eq(schema.scheduled_tasks.status, 'running'), orm.lte(schema.scheduled_tasks.running_started_at, staleBefore)))
        .returning({ id: schema.scheduled_tasks.id });
    return countRows(rows);
}
export async function deleteScheduledTask(taskId) {
    const db = await getDb();
    await db.delete(schema.scheduled_tasks)
        .where(orm.and(orm.eq(schema.scheduled_tasks.id, taskId), orm.eq(schema.scheduled_tasks.status, 'running')));
}
export async function markScheduledTaskCronRescheduled({ taskId, completedAt, nextRunAt }) {
    const db = await getDb();
    await db.update(schema.scheduled_tasks)
        .set({ status: 'planned', last_run_at: completedAt, running_started_at: null, last_error: null, next_run_at: nextRunAt })
        .where(orm.and(orm.eq(schema.scheduled_tasks.id, taskId), orm.eq(schema.scheduled_tasks.status, 'running')));
}
export async function markScheduledTaskFailed({ taskId, failedAt, errorMessage }) {
    const db = await getDb();
    await db.update(schema.scheduled_tasks)
        .set({
        status: 'failed',
        last_run_at: failedAt,
        running_started_at: null,
        last_error: errorMessage,
        attempts: orm.sql `${schema.scheduled_tasks.attempts} + 1`,
    })
        .where(orm.and(orm.eq(schema.scheduled_tasks.id, taskId), orm.eq(schema.scheduled_tasks.status, 'running')));
}
export async function markScheduledTaskCronRetry({ taskId, failedAt, errorMessage, nextRunAt }) {
    const db = await getDb();
    await db.update(schema.scheduled_tasks)
        .set({
        status: 'planned',
        next_run_at: nextRunAt,
        last_run_at: failedAt,
        running_started_at: null,
        last_error: errorMessage,
        attempts: orm.sql `${schema.scheduled_tasks.attempts} + 1`,
    })
        .where(orm.and(orm.eq(schema.scheduled_tasks.id, taskId), orm.eq(schema.scheduled_tasks.status, 'running')));
}
export async function setSessionStartSource({ sessionId, scheduleKind, scheduledTaskId }) {
    const db = await getDb();
    await db.insert(schema.session_start_sources)
        .values({ session_id: sessionId, schedule_kind: scheduleKind, scheduled_task_id: scheduledTaskId ?? null })
        .onConflictDoUpdate({
        target: schema.session_start_sources.session_id,
        set: { schedule_kind: scheduleKind, scheduled_task_id: scheduledTaskId ?? null, updated_at: new Date() },
    });
}
export async function upsertSessionSleep({ sessionId, wakeAt, reason, }) {
    const db = await getDb();
    // A new occurrence gets a fresh delivery_id, which invalidates any in-flight
    // wake for the previous occurrence: every delivery write is guarded on it.
    const deliveryId = crypto.randomUUID();
    await db.insert(schema.session_sleeps)
        .values({
        session_id: sessionId,
        wake_at: wakeAt,
        reason: reason ?? null,
        status: 'planned',
        delivery_id: deliveryId,
    })
        .onConflictDoUpdate({
        target: schema.session_sleeps.session_id,
        set: {
            wake_at: wakeAt,
            reason: reason ?? null,
            status: 'planned',
            delivery_id: deliveryId,
            attempts: 0,
            last_attempt_at: null,
            created_at: new Date(),
        },
    });
    return deliveryId;
}
export async function getSessionSleep({ sessionId }) {
    const db = await getDb();
    return await db.query.session_sleeps.findFirst({
        where: { session_id: sessionId },
    }) ?? null;
}
/** Rows that are due and not attempted too recently. Status stays `planned`. */
export async function getDueSessionSleeps({ now, retryAfterMs, limit, }) {
    const db = await getDb();
    const retryBefore = new Date(now.getTime() - retryAfterMs);
    return db.select()
        .from(schema.session_sleeps)
        .where(orm.and(orm.eq(schema.session_sleeps.status, 'planned'), orm.lte(schema.session_sleeps.wake_at, now), orm.or(orm.isNull(schema.session_sleeps.last_attempt_at), orm.lte(schema.session_sleeps.last_attempt_at, retryBefore))))
        .orderBy(orm.asc(schema.session_sleeps.wake_at))
        .limit(limit);
}
/**
 * Reserve one delivery attempt. The row never leaves `planned` here.
 *
 * Only `last_attempt_at` moves, which keeps concurrent ticks off the same row
 * for retryAfterMs. Because posting does not change the status either, one
 * retry path covers every loss: dying before the post, dying after it, or
 * never receiving the gateway event for the message we posted.
 */
export async function claimSessionSleepAttempt({ sessionId, deliveryId, now, retryAfterMs, }) {
    const db = await getDb();
    const retryBefore = new Date(now.getTime() - retryAfterMs);
    const rows = await db.update(schema.session_sleeps)
        .set({ last_attempt_at: now, attempts: orm.sql `${schema.session_sleeps.attempts} + 1` })
        .where(orm.and(orm.eq(schema.session_sleeps.session_id, sessionId), orm.eq(schema.session_sleeps.delivery_id, deliveryId), orm.eq(schema.session_sleeps.status, 'planned'), orm.lte(schema.session_sleeps.wake_at, now), orm.or(orm.isNull(schema.session_sleeps.last_attempt_at), orm.lte(schema.session_sleeps.last_attempt_at, retryBefore))))
        .returning();
    return rows[0] ?? null;
}
export async function markSessionSleepFailed({ sessionId, deliveryId, }) {
    const db = await getDb();
    const rows = await db.update(schema.session_sleeps)
        .set({ status: 'failed' })
        .where(orm.and(orm.eq(schema.session_sleeps.session_id, sessionId), orm.eq(schema.session_sleeps.delivery_id, deliveryId), orm.eq(schema.session_sleeps.status, 'planned')))
        .returning({ session_id: schema.session_sleeps.session_id });
    return countRows(rows) > 0;
}
/**
 * Ingress commit point. Marks the wake as delivered to the session.
 *
 * Returns false when the row is missing or no longer `planned`, which is how a
 * wake that raced a user cancellation, or a duplicate of one already delivered,
 * gets dropped instead of starting a turn.
 */
export async function consumeSessionSleepWake({ deliveryId }) {
    const db = await getDb();
    const rows = await db.update(schema.session_sleeps)
        .set({ status: 'consumed' })
        .where(orm.and(orm.eq(schema.session_sleeps.delivery_id, deliveryId), orm.eq(schema.session_sleeps.status, 'planned')))
        .returning({ session_id: schema.session_sleeps.session_id });
    return countRows(rows) > 0;
}
/**
 * Cancel the pending sleep of the session currently bound to a thread.
 *
 * Runs on every ingress, so the binding is resolved with a correlated subquery
 * rather than a second round trip. thread_id is the primary key of
 * thread_sessions, so it yields at most one session.
 */
export async function cancelSessionSleepForThread({ threadId }) {
    const db = await getDb();
    const rows = await db.update(schema.session_sleeps)
        .set({ status: 'cancelled' })
        .where(orm.and(orm.eq(schema.session_sleeps.status, 'planned'), orm.eq(schema.session_sleeps.session_id, orm.sql `(SELECT ${schema.thread_sessions.session_id} FROM ${schema.thread_sessions} WHERE ${schema.thread_sessions.thread_id} = ${threadId})`)))
        .returning({ session_id: schema.session_sleeps.session_id });
    return countRows(rows) > 0;
}
export async function getSessionStartSourcesBySessionIds(sessionIds) {
    if (sessionIds.length === 0)
        return new Map();
    const db = await getDb();
    const chunkSize = 500;
    const rows = [];
    for (let index = 0; index < sessionIds.length; index += chunkSize) {
        rows.push(...await db.query.session_start_sources.findMany({
            where: { session_id: { in: sessionIds.slice(index, index + chunkSize) } },
        }));
    }
    return new Map(rows.map((row) => [row.session_id, row]));
}
export async function getSessionStartSource({ sessionId }) {
    const db = await getDb();
    return await db.query.session_start_sources.findFirst({
        where: { session_id: sessionId },
    }) ?? null;
}
export async function getChannelModel(channelId) {
    const db = await getDb();
    const row = await db.query.channel_models.findFirst({ where: { channel_id: channelId } });
    return row ? { modelId: row.model_id, variant: row.variant } : undefined;
}
export async function setChannelModel({ channelId, modelId, variant }) {
    const db = await getDb();
    await db.insert(schema.channel_models)
        .values({ channel_id: channelId, model_id: modelId, variant: variant ?? null })
        .onConflictDoUpdate({
        target: schema.channel_models.channel_id,
        set: { model_id: modelId, variant: variant ?? null, updated_at: new Date() },
    });
}
export async function getGlobalModel(appId) {
    const db = await getDb();
    const row = await db.query.global_models.findFirst({ where: { app_id: appId } });
    return row ? { modelId: row.model_id, variant: row.variant } : undefined;
}
export async function setGlobalModel({ appId, modelId, variant }) {
    const db = await getDb();
    await db.insert(schema.global_models)
        .values({ app_id: appId, model_id: modelId, variant: variant ?? null })
        .onConflictDoUpdate({
        target: schema.global_models.app_id,
        set: { model_id: modelId, variant: variant ?? null, updated_at: new Date() },
    });
}
export async function getSessionModel(sessionId) {
    const db = await getDb();
    const row = await db.query.session_models.findFirst({ where: { session_id: sessionId } });
    return row ? { modelId: row.model_id, variant: row.variant } : undefined;
}
export async function setSessionModel({ sessionId, modelId, variant }) {
    const db = await getDb();
    await db.insert(schema.session_models)
        .values({ session_id: sessionId, model_id: modelId, variant: variant ?? null })
        .onConflictDoUpdate({
        target: schema.session_models.session_id,
        set: { model_id: modelId, variant: variant ?? null },
    });
}
export async function clearSessionModel(sessionId) {
    const db = await getDb();
    await db.delete(schema.session_models).where(orm.eq(schema.session_models.session_id, sessionId));
}
export async function getVariantCascade({ sessionId, channelId, appId }) {
    if (sessionId) {
        const session = await getSessionModel(sessionId);
        if (session?.variant)
            return session.variant;
    }
    if (channelId) {
        const channel = await getChannelModel(channelId);
        if (channel?.variant)
            return channel.variant;
    }
    if (appId) {
        const global = await getGlobalModel(appId);
        if (global?.variant)
            return global.variant;
    }
    return undefined;
}
export async function getChannelAgent(channelId) {
    const db = await getDb();
    return (await db.query.channel_agents.findFirst({ where: { channel_id: channelId } }))?.agent_name;
}
export async function setChannelAgent(channelId, agentName) {
    const db = await getDb();
    await db.insert(schema.channel_agents)
        .values({ channel_id: channelId, agent_name: agentName })
        .onConflictDoUpdate({ target: schema.channel_agents.channel_id, set: { agent_name: agentName, updated_at: new Date() } });
}
export async function getSessionAgent(sessionId) {
    const db = await getDb();
    return (await db.query.session_agents.findFirst({ where: { session_id: sessionId } }))?.agent_name;
}
export async function setSessionAgent(sessionId, agentName) {
    const db = await getDb();
    await db.insert(schema.session_agents)
        .values({ session_id: sessionId, agent_name: agentName })
        .onConflictDoUpdate({ target: schema.session_agents.session_id, set: { agent_name: agentName } });
}
export async function getThreadWorktree(threadId) {
    const db = await getDb();
    return await db.query.thread_worktrees.findFirst({ where: { thread_id: threadId } }) ?? undefined;
}
export async function createPendingWorktree({ threadId, worktreeName, projectDirectory }) {
    const db = await getDb();
    await db.batch([
        db.insert(schema.thread_sessions)
            .values({ thread_id: threadId, session_id: '' })
            .onConflictDoNothing({ target: schema.thread_sessions.thread_id }),
        db.insert(schema.thread_worktrees)
            .values({ thread_id: threadId, worktree_name: worktreeName, project_directory: projectDirectory, status: 'pending' })
            .onConflictDoUpdate({
            target: schema.thread_worktrees.thread_id,
            set: { worktree_name: worktreeName, project_directory: projectDirectory, status: 'pending', worktree_directory: null, error_message: null },
        }),
    ]);
}
export async function setWorktreeReady({ threadId, worktreeDirectory }) {
    const db = await getDb();
    await db.update(schema.thread_worktrees).set({ worktree_directory: worktreeDirectory, status: 'ready' }).where(orm.eq(schema.thread_worktrees.thread_id, threadId));
}
export async function setWorktreeError({ threadId, errorMessage }) {
    const db = await getDb();
    await db.update(schema.thread_worktrees).set({ status: 'error', error_message: errorMessage }).where(orm.eq(schema.thread_worktrees.thread_id, threadId));
}
export async function deleteThreadWorktree(threadId) {
    const db = await getDb();
    await db.delete(schema.thread_worktrees).where(orm.eq(schema.thread_worktrees.thread_id, threadId));
}
export async function createPendingWorkspace({ threadId, workspaceType, workspaceName, projectDirectory, }) {
    const db = await getDb();
    await db.batch([
        db.insert(schema.thread_sessions)
            .values({ thread_id: threadId, session_id: '' })
            .onConflictDoNothing({ target: schema.thread_sessions.thread_id }),
        db.insert(schema.thread_workspaces)
            .values({
            thread_id: threadId,
            workspace_type: workspaceType,
            workspace_name: workspaceName,
            project_directory: projectDirectory,
            status: 'pending',
        })
            .onConflictDoUpdate({
            target: schema.thread_workspaces.thread_id,
            set: {
                workspace_type: workspaceType,
                workspace_name: workspaceName,
                project_directory: projectDirectory,
                status: 'pending',
                workspace_id: null,
                workspace_directory: null,
                error_message: null,
            },
        }),
    ]);
}
export async function setWorkspaceReady({ threadId, workspaceId, workspaceDirectory, }) {
    const db = await getDb();
    await db.update(schema.thread_workspaces)
        .set({
        workspace_directory: workspaceDirectory,
        workspace_id: workspaceId ?? null,
        status: 'ready',
    })
        .where(orm.eq(schema.thread_workspaces.thread_id, threadId));
}
export async function setWorkspaceError({ threadId, errorMessage, }) {
    const db = await getDb();
    await db.update(schema.thread_workspaces)
        .set({ status: 'error', error_message: errorMessage })
        .where(orm.eq(schema.thread_workspaces.thread_id, threadId));
}
export async function getThreadWorkspace(threadId) {
    const db = await getDb();
    return await db.query.thread_workspaces.findFirst({ where: { thread_id: threadId } }) ?? undefined;
}
export async function deleteThreadWorkspace(threadId) {
    const db = await getDb();
    await db.delete(schema.thread_workspaces).where(orm.eq(schema.thread_workspaces.thread_id, threadId));
}
/** Alias for getThreadWorkspace — used throughout the codebase. */
export const getThreadWorktreeOrWorkspace = getThreadWorkspace;
export async function getChannelVerbosity(channelId) {
    const db = await getDb();
    const row = await db.query.channel_verbosity.findFirst({ where: { channel_id: channelId } });
    return row?.verbosity ?? store.getState().defaultVerbosity;
}
export async function setChannelVerbosity(channelId, verbosity) {
    const db = await getDb();
    await db.insert(schema.channel_verbosity)
        .values({ channel_id: channelId, verbosity })
        .onConflictDoUpdate({ target: schema.channel_verbosity.channel_id, set: { verbosity, updated_at: new Date() } });
}
export async function getChannelMentionMode(channelId) {
    const db = await getDb();
    const row = await db.query.channel_mention_mode.findFirst({ where: { channel_id: channelId } });
    return row ? row.enabled === 1 : store.getState().defaultMentionMode;
}
export async function setChannelMentionMode(channelId, enabled) {
    const db = await getDb();
    await db.insert(schema.channel_mention_mode)
        .values({ channel_id: channelId, enabled: enabled ? 1 : 0 })
        .onConflictDoUpdate({ target: schema.channel_mention_mode.channel_id, set: { enabled: enabled ? 1 : 0, updated_at: new Date() } });
}
export async function getChannelWorktreesEnabled(channelId) {
    const db = await getDb();
    return (await db.query.channel_worktrees.findFirst({ where: { channel_id: channelId } }))?.enabled === 1;
}
export async function setChannelWorktreesEnabled(channelId, enabled) {
    const db = await getDb();
    await db.insert(schema.channel_worktrees)
        .values({ channel_id: channelId, enabled: enabled ? 1 : 0 })
        .onConflictDoUpdate({ target: schema.channel_worktrees.channel_id, set: { enabled: enabled ? 1 : 0, updated_at: new Date() } });
}
export async function getChannelDirectory(channelId) {
    const db = await getDb();
    const row = await db.query.channel_directories.findFirst({ where: { channel_id: channelId } });
    return row ? { directory: row.directory } : undefined;
}
export async function getThreadSession(threadId) {
    const db = await getDb();
    return (await db.query.thread_sessions.findFirst({ where: { thread_id: threadId } }))?.session_id;
}
export async function insertThreadQueueItem({ queueId, threadId, payloadJson, }) {
    const db = await getDb();
    await db.insert(schema.thread_queue_items).values({
        queue_id: queueId,
        thread_id: threadId,
        payload_json: payloadJson,
    });
}
export async function listThreadQueueItems(threadId) {
    const db = await getDb();
    return db.query.thread_queue_items.findMany({
        where: { thread_id: threadId },
        orderBy: { id: 'asc' },
    });
}
export async function listAllThreadQueueItems() {
    const db = await getDb();
    return db.query.thread_queue_items.findMany({
        orderBy: { id: 'asc' },
    });
}
export async function deleteThreadQueueItem(queueId) {
    const db = await getDb();
    const rows = await db.delete(schema.thread_queue_items).where(orm.eq(schema.thread_queue_items.queue_id, queueId)).returning();
    return rows[0];
}
export async function deleteThreadQueueItems(threadId) {
    const db = await getDb();
    await db.delete(schema.thread_queue_items).where(orm.eq(schema.thread_queue_items.thread_id, threadId));
}
export async function updateThreadQueueItemPayload({ queueId, payloadJson, }) {
    const db = await getDb();
    await db.update(schema.thread_queue_items)
        .set({ payload_json: payloadJson })
        .where(orm.eq(schema.thread_queue_items.queue_id, queueId));
}
export async function setThreadSession(threadId, sessionId) {
    await upsertThreadSession({ threadId, sessionId, source: 'dorimaki' });
}
export async function upsertThreadSession({ threadId, sessionId, source }) {
    const db = await getDb();
    // updated_at is written explicitly on BOTH paths, never left to the column's
    // CURRENT_TIMESTAMP default. The default stores "YYYY-MM-DD HH:MM:SS" while
    // Date values store ISO with a "T", and those two text formats do not sort
    // against each other correctly. Writing ISO everywhere keeps the ordering in
    // getThreadIdBySessionId honest and gives it millisecond resolution.
    const boundAt = new Date();
    await db.insert(schema.thread_sessions)
        .values({ thread_id: threadId, session_id: sessionId, source, updated_at: boundAt })
        .onConflictDoUpdate({
        target: schema.thread_sessions.thread_id,
        set: { session_id: sessionId, source, updated_at: boundAt },
    });
}
export async function getThreadParentSessionId(threadId) {
    const db = await getDb();
    return (await db.query.thread_sessions.findFirst({
        where: { thread_id: threadId },
        columns: { parent_session_id: true },
    }))?.parent_session_id ?? undefined;
}
export async function setThreadParentSessionId({ threadId, parentSessionId, }) {
    const db = await getDb();
    await db
        .update(schema.thread_sessions)
        .set({ parent_session_id: parentSessionId })
        .where(orm.eq(schema.thread_sessions.thread_id, threadId));
}
export async function getThreadSessionSource(threadId) {
    const db = await getDb();
    return (await db.query.thread_sessions.findFirst({ where: { thread_id: threadId }, columns: { source: true } }))?.source;
}
/**
 * Reverse lookup of the Discord thread that currently owns an OpenCode session.
 *
 * `thread_sessions.session_id` is NOT unique: /resume binds an existing session
 * to a brand new thread without clearing the old row. An unordered findFirst
 * therefore returns an arbitrary (often dead) thread, which made plugin tools
 * post into the wrong conversation. Order by the most recent binding instead,
 * falling back to created_at for rows written before updated_at existed.
 */
export async function getThreadIdBySessionId(sessionId) {
    const db = await getDb();
    const rows = await db.select({ thread_id: schema.thread_sessions.thread_id })
        .from(schema.thread_sessions)
        .where(orm.eq(schema.thread_sessions.session_id, sessionId))
        .orderBy(orm.desc(orm.sql `COALESCE(${schema.thread_sessions.updated_at}, ${schema.thread_sessions.created_at})`))
        .limit(1);
    return rows[0]?.thread_id;
}
export async function getAllThreadSessionIds() {
    const db = await getDb();
    const rows = await db.query.thread_sessions.findMany({ columns: { session_id: true } });
    return rows.map((row) => row.session_id).filter((id) => id !== '');
}
export async function appendSessionEventsSinceLastTimestamp({ sessionId, events }) {
    if (events.length === 0)
        return 0;
    const db = await getDb();
    const sortedEvents = [...events].sort((a, b) => {
        if (a.timestamp !== b.timestamp)
            return a.timestamp - b.timestamp;
        return a.event_index - b.event_index;
    });
    const latestPersisted = await db.query.session_events.findFirst({
        where: { session_id: sessionId },
        orderBy: { timestamp: 'desc', event_index: 'desc', id: 'desc' },
        columns: { timestamp: true, event_index: true },
    });
    const eventsToInsert = sortedEvents.filter((event) => {
        if (!latestPersisted)
            return true;
        if (event.timestamp > latestPersisted.timestamp)
            return true;
        if (event.timestamp < latestPersisted.timestamp)
            return false;
        return event.event_index > latestPersisted.event_index;
    });
    if (eventsToInsert.length === 0)
        return 0;
    await db.insert(schema.session_events).values(eventsToInsert);
    const staleRows = await db.query.session_events.findMany({
        where: { session_id: sessionId },
        orderBy: { timestamp: 'desc', event_index: 'desc', id: 'desc' },
        limit: 1_000_000,
        offset: 1000,
        columns: { id: true },
    });
    if (staleRows.length > 0) {
        await db.delete(schema.session_events).where(orm.inArray(schema.session_events.id, staleRows.map((row) => row.id)));
    }
    return eventsToInsert.length;
}
export async function getSessionEventSnapshot({ sessionId }) {
    const db = await getDb();
    return db.query.session_events.findMany({
        where: { session_id: sessionId },
        orderBy: { timestamp: 'asc', event_index: 'asc', id: 'asc' },
        limit: 1000,
    });
}
export async function getPartMessageIds(threadId) {
    const db = await getDb();
    const rows = await db.query.part_messages.findMany({ where: { thread_id: threadId }, columns: { part_id: true } });
    return rows.map((row) => row.part_id);
}
export async function setPartMessage({ partId, messageId, threadId }) {
    const db = await getDb();
    await db.insert(schema.part_messages)
        .values({ part_id: partId, message_id: messageId, thread_id: threadId })
        .onConflictDoUpdate({ target: schema.part_messages.part_id, set: { message_id: messageId, thread_id: threadId } });
}
export async function setPartMessagesBatch(partMappings) {
    if (partMappings.length === 0)
        return;
    const db = await getDb();
    for (const { partId, messageId, threadId } of partMappings) {
        await db.insert(schema.part_messages)
            .values({ part_id: partId, message_id: messageId, thread_id: threadId })
            .onConflictDoUpdate({ target: schema.part_messages.part_id, set: { message_id: messageId, thread_id: threadId } });
    }
}
function splitServiceAuthToken({ token }) {
    const separatorIndex = token.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex >= token.length - 1)
        return null;
    return { clientId: token.slice(0, separatorIndex), clientSecret: token.slice(separatorIndex + 1) };
}
function createServiceCredentials() {
    return { clientId: crypto.randomUUID(), clientSecret: crypto.randomBytes(32).toString('hex') };
}
export async function getBotTokenWithMode() {
    const db = await getDb();
    const [row] = await db.query.bot_tokens.findMany({ orderBy: { last_used_at: 'desc', created_at: 'desc' }, limit: 1 });
    if (!row)
        return undefined;
    const gatewayToken = await ensureServiceAuthToken({ appId: row.app_id });
    const serviceParts = splitServiceAuthToken({ token: gatewayToken });
    const mode = row.bot_mode === 'gateway' ? 'gateway' : 'self_hosted';
    const token = mode === 'gateway' && serviceParts ? gatewayToken : row.token;
    const discordBaseUrl = mode === 'gateway' && row.proxy_url ? row.proxy_url : 'https://discord.com';
    store.setState({ discordBaseUrl, gatewayToken });
    return {
        appId: row.app_id,
        token,
        gatewayToken,
        mode,
        clientId: serviceParts?.clientId || row.client_id,
        clientSecret: serviceParts?.clientSecret || row.client_secret,
        proxyUrl: row.proxy_url,
    };
}
export async function ensureServiceAuthToken({ appId, preferredGatewayToken }) {
    const db = await getDb();
    const row = await db.query.bot_tokens.findFirst({ where: { app_id: appId } });
    if (!row)
        throw new Error(`Bot token row not found for app_id ${appId}`);
    const preferred = preferredGatewayToken ? splitServiceAuthToken({ token: preferredGatewayToken }) : null;
    const existing = row.client_id && row.client_secret ? { clientId: row.client_id, clientSecret: row.client_secret } : null;
    const fromStoredToken = splitServiceAuthToken({ token: row.token });
    const resolved = preferred || existing || fromStoredToken || createServiceCredentials();
    if (row.client_id !== resolved.clientId || row.client_secret !== resolved.clientSecret) {
        await db.update(schema.bot_tokens)
            .set({ client_id: resolved.clientId, client_secret: resolved.clientSecret })
            .where(orm.eq(schema.bot_tokens.app_id, appId));
    }
    return `${resolved.clientId}:${resolved.clientSecret}`;
}
export async function setBotToken(appId, token) {
    const db = await getDb();
    const generated = createServiceCredentials();
    await db.insert(schema.bot_tokens)
        .values({ app_id: appId, token, client_id: generated.clientId, client_secret: generated.clientSecret })
        .onConflictDoUpdate({ target: schema.bot_tokens.app_id, set: { token } });
    await ensureServiceAuthToken({ appId });
}
export async function setBotMode({ appId, mode, clientId, clientSecret, proxyUrl }) {
    const db = await getDb();
    const token = clientId && clientSecret ? `${clientId}:${clientSecret}` : '';
    const data = { bot_mode: mode, client_id: clientId ?? null, client_secret: clientSecret ?? null, proxy_url: proxyUrl ?? null };
    await db.insert(schema.bot_tokens)
        .values({ app_id: appId, token, ...data })
        .onConflictDoUpdate({ target: schema.bot_tokens.app_id, set: data });
    await ensureServiceAuthToken({ appId, preferredGatewayToken: token || undefined });
}
export async function getGeminiApiKey(appId) {
    const db = await getDb();
    return (await db.query.bot_api_keys.findFirst({ where: { app_id: appId } }))?.gemini_api_key ?? null;
}
export async function setGeminiApiKey(appId, apiKey) {
    const db = await getDb();
    await db.insert(schema.bot_api_keys)
        .values({ app_id: appId, gemini_api_key: apiKey })
        .onConflictDoUpdate({ target: schema.bot_api_keys.app_id, set: { gemini_api_key: apiKey } });
}
export async function getOpenAIApiKey(appId) {
    const db = await getDb();
    return (await db.query.bot_api_keys.findFirst({ where: { app_id: appId } }))?.openai_api_key ?? null;
}
export async function setOpenAIApiKey(appId, apiKey) {
    const db = await getDb();
    await db.insert(schema.bot_api_keys)
        .values({ app_id: appId, openai_api_key: apiKey })
        .onConflictDoUpdate({ target: schema.bot_api_keys.app_id, set: { openai_api_key: apiKey } });
}
export async function getTranscriptionApiKey(appId) {
    const db = await getDb();
    const row = await db.query.bot_api_keys.findFirst({ where: { app_id: appId } });
    if (!row)
        return null;
    if (row.openai_api_key)
        return { provider: 'openai', apiKey: row.openai_api_key };
    if (row.gemini_api_key)
        return { provider: 'gemini', apiKey: row.gemini_api_key };
    return null;
}
/**
 * Get any stored audio API key (OpenAI or Gemini) without requiring a specific appId.
 * Used by the plugin process which doesn't have direct access to the bot's appId.
 * Returns the first available key found, preferring OpenAI.
 */
export async function getAnyAudioApiKey() {
    const db = await getDb();
    const row = await db.query.bot_api_keys.findFirst();
    if (!row)
        return null;
    if (row.openai_api_key)
        return { provider: 'openai', apiKey: row.openai_api_key, appId: row.app_id };
    if (row.gemini_api_key)
        return { provider: 'gemini', apiKey: row.gemini_api_key, appId: row.app_id };
    return null;
}
export async function setChannelDirectory({ channelId, directory, channelType, guildId, skipIfExists = false }) {
    const db = await getDb();
    if (skipIfExists) {
        await db.insert(schema.channel_directories)
            .values({ channel_id: channelId, directory, channel_type: channelType, guild_id: guildId })
            .onConflictDoNothing({ target: schema.channel_directories.channel_id });
        return;
    }
    await db.insert(schema.channel_directories)
        .values({ channel_id: channelId, directory, channel_type: channelType, guild_id: guildId })
        .onConflictDoUpdate({ target: schema.channel_directories.channel_id, set: { directory, channel_type: channelType, guild_id: guildId } });
}
export async function findChannelsByDirectory({ directory, channelType }) {
    const db = await getDb();
    const where = directory && channelType
        ? { directory, channel_type: channelType }
        : directory
            ? { directory }
            : channelType
                ? { channel_type: channelType }
                : undefined;
    return db.query.channel_directories.findMany({ where, columns: { channel_id: true, directory: true, channel_type: true, guild_id: true } });
}
function canonicalizeDirectory(directory) {
    const resolved = path.resolve(directory);
    const real = errore.try(() => fs.realpathSync(resolved), (e) => new Error('realpath failed', { cause: e }));
    if (real instanceof Error)
        return resolved;
    return real;
}
export async function findRegisteredTextChannelForDirectory(directory) {
    const wanted = canonicalizeDirectory(directory);
    const channels = await findChannelsByDirectory({ channelType: 'text' });
    return channels.find((ch) => canonicalizeDirectory(ch.directory) === wanted) ?? null;
}
export function formatProjectAlreadyRegisteredError({ channelId, directory, }) {
    return [
        `Channel already exists for this directory: ${directory}`,
        `Channel ID: ${channelId}`,
        `Remove the mapping first: dorimaki project remove ${channelId}`,
    ].join('\n');
}
export async function getAllTextChannelDirectories() {
    const db = await getDb();
    const rows = await db.query.channel_directories.findMany({ where: { channel_type: 'text' }, columns: { directory: true } });
    return [...new Set(rows.map((row) => row.directory))];
}
export async function listTrackedTextChannels() {
    const db = await getDb();
    return db.query.channel_directories.findMany({
        where: { channel_type: 'text' },
        orderBy: { created_at: 'asc', channel_id: 'asc' },
        columns: { channel_id: true, directory: true, created_at: true },
    });
}
export async function getGuildCategories(guildId) {
    const db = await getDb();
    const row = await db.query.guild_categories.findFirst({ where: { guild_id: guildId } });
    if (!row)
        return null;
    return {
        guild_id: row.guild_id,
        category_id: row.category_id,
        audio_category_id: row.audio_category_id,
    };
}
export async function listGuildCategoryIds() {
    const db = await getDb();
    const rows = await db.query.guild_categories.findMany({
        columns: { category_id: true, audio_category_id: true },
    });
    const ids = new Set();
    for (const row of rows) {
        if (row.category_id)
            ids.add(row.category_id);
        if (row.audio_category_id)
            ids.add(row.audio_category_id);
    }
    return [...ids];
}
export async function setGuildCategoryId({ guildId, kind, categoryId, }) {
    const db = await getDb();
    const values = kind === 'audio'
        ? { guild_id: guildId, audio_category_id: categoryId }
        : { guild_id: guildId, category_id: categoryId };
    const set = kind === 'audio'
        ? { audio_category_id: categoryId }
        : { category_id: categoryId };
    await db.insert(schema.guild_categories)
        .values(values)
        .onConflictDoUpdate({
        target: schema.guild_categories.guild_id,
        set,
    });
}
export async function deleteChannelDirectoriesByDirectory(directory) {
    const db = await getDb();
    await db.delete(schema.channel_directories).where(orm.eq(schema.channel_directories.directory, directory));
}
export async function deleteChannelDirectoryById(channelId, { preserveMapping = false } = {}) {
    const db = await getDb();
    await db.batch([
        db.update(schema.scheduled_tasks)
            .set({
            status: 'cancelled',
            running_started_at: null,
            last_error: 'Discord channel was deleted',
        })
            .where(orm.and(orm.eq(schema.scheduled_tasks.channel_id, channelId), orm.inArray(schema.scheduled_tasks.status, ['planned', 'running']))),
        db.delete(schema.channel_models).where(orm.eq(schema.channel_models.channel_id, channelId)),
        db.delete(schema.channel_agents).where(orm.eq(schema.channel_agents.channel_id, channelId)),
        db.delete(schema.channel_worktrees).where(orm.eq(schema.channel_worktrees.channel_id, channelId)),
        db.delete(schema.channel_verbosity).where(orm.eq(schema.channel_verbosity.channel_id, channelId)),
        db.delete(schema.channel_mention_mode).where(orm.eq(schema.channel_mention_mode.channel_id, channelId)),
    ]);
    if (preserveMapping) {
        return Boolean(await db.query.channel_directories.findFirst({
            where: { channel_id: channelId },
            columns: { channel_id: true },
        }));
    }
    const rows = await db.delete(schema.channel_directories)
        .where(orm.eq(schema.channel_directories.channel_id, channelId))
        .returning({ channel_id: schema.channel_directories.channel_id });
    return rows.length > 0;
}
export async function cleanupDeletedThread(threadId) {
    const db = await getDb();
    const binding = await db.query.thread_sessions.findFirst({
        where: { thread_id: threadId },
        columns: { session_id: true },
    });
    const currentThreadId = binding
        ? await getThreadIdBySessionId(binding.session_id)
        : undefined;
    const currentSessionId = currentThreadId === threadId
        ? binding?.session_id
        : undefined;
    await db.batch([
        db.delete(schema.thread_queue_items)
            .where(orm.eq(schema.thread_queue_items.thread_id, threadId)),
        db.update(schema.session_sleeps)
            .set({ status: 'cancelled' })
            .where(orm.and(orm.eq(schema.session_sleeps.status, 'planned'), orm.eq(schema.session_sleeps.session_id, currentSessionId ?? ''))),
        db.update(schema.scheduled_tasks)
            .set({
            status: 'cancelled',
            running_started_at: null,
            last_error: 'Discord thread was deleted',
        })
            .where(orm.and(orm.eq(schema.scheduled_tasks.thread_id, threadId), orm.inArray(schema.scheduled_tasks.status, ['planned', 'running']))),
        db.update(schema.ipc_requests)
            .set({
            status: 'cancelled',
            response: JSON.stringify({ error: 'Discord thread was deleted' }),
        })
            .where(orm.and(orm.eq(schema.ipc_requests.thread_id, threadId), orm.inArray(schema.ipc_requests.status, ['pending', 'processing']))),
    ]);
}
export async function isCurrentThreadSessionBinding(threadId) {
    const db = await getDb();
    const binding = await db.query.thread_sessions.findFirst({
        where: { thread_id: threadId },
        columns: { session_id: true },
    });
    if (!binding)
        return false;
    return await getThreadIdBySessionId(binding.session_id) === threadId;
}
export async function clearGuildCategoryByChannelId(channelId) {
    const db = await getDb();
    await db.batch([
        db.update(schema.guild_categories)
            .set({ category_id: null })
            .where(orm.eq(schema.guild_categories.category_id, channelId)),
        db.update(schema.guild_categories)
            .set({ audio_category_id: null })
            .where(orm.eq(schema.guild_categories.audio_category_id, channelId)),
    ]);
}
export async function getVoiceChannelDirectory(channelId) {
    const db = await getDb();
    return (await db.query.channel_directories.findFirst({ where: { channel_id: channelId, channel_type: 'voice' } }))?.directory;
}
export async function findTextChannelByVoiceChannel(voiceChannelId) {
    const db = await getDb();
    const voiceChannel = await db.query.channel_directories.findFirst({ where: { channel_id: voiceChannelId, channel_type: 'voice' } });
    if (!voiceChannel)
        return undefined;
    return (await db.query.channel_directories.findFirst({ where: { directory: voiceChannel.directory, channel_type: 'text' } }))?.channel_id;
}
export async function getForumSyncConfigs({ appId }) {
    const db = await getDb();
    const rows = await db.query.forum_sync_configs.findMany({ where: { app_id: appId } });
    return rows.map((row) => ({ appId: row.app_id, forumChannelId: row.forum_channel_id, outputDir: row.output_dir, direction: row.direction }));
}
export async function upsertForumSyncConfig({ appId, forumChannelId, outputDir, direction = 'bidirectional' }) {
    const db = await getDb();
    await db.insert(schema.forum_sync_configs)
        .values({ app_id: appId, forum_channel_id: forumChannelId, output_dir: outputDir, direction })
        .onConflictDoUpdate({ target: [schema.forum_sync_configs.app_id, schema.forum_sync_configs.forum_channel_id], set: { output_dir: outputDir, direction, updated_at: new Date() } });
}
export async function deleteForumSyncConfig({ appId, forumChannelId }) {
    const db = await getDb();
    await db.delete(schema.forum_sync_configs).where(orm.and(orm.eq(schema.forum_sync_configs.app_id, appId), orm.eq(schema.forum_sync_configs.forum_channel_id, forumChannelId)));
}
export async function deleteStaleForumSyncConfigs({ appId, forumChannelId, outputDir }) {
    const db = await getDb();
    await db.delete(schema.forum_sync_configs).where(orm.and(orm.eq(schema.forum_sync_configs.app_id, appId), orm.eq(schema.forum_sync_configs.output_dir, outputDir), orm.ne(schema.forum_sync_configs.forum_channel_id, forumChannelId)));
}
export async function createIpcRequest({ type, sessionId, threadId, payload }) {
    const db = await getDb();
    const [row] = await db.insert(schema.ipc_requests).values({ type, session_id: sessionId, thread_id: threadId, payload }).returning();
    if (!row)
        throw new Error('Failed to create IPC request');
    return row;
}
export async function claimPendingIpcRequests() {
    const db = await getDb();
    const pending = await db.query.ipc_requests.findMany({ where: { status: 'pending' }, orderBy: { created_at: 'asc' } });
    const claimed = [];
    for (const req of pending) {
        const rows = await db.update(schema.ipc_requests)
            .set({ status: 'processing' })
            .where(orm.and(orm.eq(schema.ipc_requests.id, req.id), orm.eq(schema.ipc_requests.status, 'pending')))
            .returning();
        if (rows.length > 0)
            claimed.push(req);
    }
    return claimed;
}
export async function completeIpcRequest({ id, response }) {
    const db = await getDb();
    const [row] = await db.update(schema.ipc_requests)
        .set({ response, status: 'completed' })
        .where(orm.and(orm.eq(schema.ipc_requests.id, id), orm.inArray(schema.ipc_requests.status, ['pending', 'processing'])))
        .returning();
    return row;
}
export async function getIpcRequestById({ id }) {
    const db = await getDb();
    return await db.query.ipc_requests.findFirst({ where: { id } }) ?? null;
}
export async function cancelStaleProcessingRequests({ ttlMs }) {
    const db = await getDb();
    const cutoff = new Date(Date.now() - ttlMs);
    const rows = await db.update(schema.ipc_requests)
        .set({ status: 'cancelled', response: JSON.stringify({ error: 'Request timed out' }) })
        .where(orm.and(orm.eq(schema.ipc_requests.status, 'processing'), orm.lt(schema.ipc_requests.updated_at, cutoff)))
        .returning({ id: schema.ipc_requests.id });
    return { count: rows.length };
}
export async function cancelAllPendingIpcRequests() {
    const db = await getDb();
    await db.update(schema.ipc_requests)
        .set({ status: 'cancelled', response: JSON.stringify({ error: 'Bot shutting down' }) })
        .where(orm.inArray(schema.ipc_requests.status, ['pending', 'processing']));
}
