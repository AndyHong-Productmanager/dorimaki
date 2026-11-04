import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DorimakiError, type Conversation, type Project, type Store } from "../contracts";

type Row = Record<string, unknown>;

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || [...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new DorimakiError("invalid_record", `${field} must be a nonempty string without control characters`);
  }
  return value;
}

function projectRecord(row: Row): Project {
  return {
    id: text(row["id"], "id"),
    guildId: text(row["guildId"], "guildId"),
    channelId: text(row["channelId"], "channelId"),
    directory: text(row["directory"], "directory"),
  };
}

function conversationRecord(row: Row): Conversation {
  if (row["active"] !== 0 && row["active"] !== 1) {
    throw new DorimakiError("invalid_record", "active must be a SQLite boolean");
  }
  return {
    threadId: text(row["threadId"], "threadId"),
    projectId: text(row["projectId"], "projectId"),
    sessionId: text(row["sessionId"], "sessionId"),
    sessionFile: text(row["sessionFile"], "sessionFile"),
    active: row["active"] === 1,
  };
}

/** One database represents one local bot. Resume ownership is checked by callers. */
export function openStore(dataDir: string): Store {
  text(dataDir, "dataDir");
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(realpathSync(dataDir), "dorimaki.sqlite"), { strict: true });
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
        guildId TEXT NOT NULL CHECK(length(trim(guildId)) > 0),
        channelId TEXT NOT NULL UNIQUE CHECK(length(trim(channelId)) > 0),
        directory TEXT NOT NULL UNIQUE CHECK(length(trim(directory)) > 0),
        directoryIdentity TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conversations (
        threadId TEXT PRIMARY KEY CHECK(length(trim(threadId)) > 0),
        projectId TEXT NOT NULL REFERENCES projects(id),
        sessionId TEXT NOT NULL CHECK(length(trim(sessionId)) > 0),
        sessionFile TEXT NOT NULL CHECK(length(trim(sessionFile)) > 0),
        active INTEGER NOT NULL CHECK(active IN (0, 1))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_thread_per_session
        ON conversations(sessionId) WHERE active = 1;
      CREATE TABLE IF NOT EXISTS ingress (
        messageId TEXT PRIMARY KEY CHECK(length(trim(messageId)) > 0),
        state TEXT NOT NULL CHECK(state IN ('claimed', 'completed', 'failed', 'uncertain'))
      ) STRICT;
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  let closed = false;
  function checkOpen(): void {
    if (closed) throw new DorimakiError("store_closed", "The storage connection is closed");
  }
  function conflict(message: string): never {
    throw new DorimakiError("conflict", message);
  }
  const findProject = db.query<Row, [string]>("SELECT * FROM projects WHERE channelId = ?");
  const findConversation = db.query<Row, [string]>("SELECT * FROM conversations WHERE threadId = ?");
  const bind = db.transaction((input: Conversation) => {
    const project = db.query<Row, [string]>("SELECT id FROM projects WHERE id = ?").get(input.projectId);
    if (!project) throw new DorimakiError("unmapped_project", "Conversation project does not exist");
    const previous = findConversation.get(input.threadId);
    if (previous && (
      previous["projectId"] !== input.projectId ||
      previous["sessionId"] !== input.sessionId ||
      previous["sessionFile"] !== input.sessionFile
    )) conflict("A thread cannot be rebound to another project or session");
    if (input.active) {
      db.query("UPDATE conversations SET active = 0 WHERE sessionId = ? AND active = 1 AND threadId <> ?")
        .run(input.sessionId, input.threadId);
    }
    db.query(`
      INSERT INTO conversations (threadId, projectId, sessionId, sessionFile, active)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(threadId) DO UPDATE SET active = excluded.active
    `).run(input.threadId, input.projectId, input.sessionId, input.sessionFile, Number(input.active));
  });
  const finish = db.transaction((messageId: string, outcome: string) => {
    const row = db.query<Row, [string]>("SELECT state FROM ingress WHERE messageId = ?").get(messageId);
    if (!row) throw new DorimakiError("invalid_transition", "Message must be claimed before finishing");
    if (row["state"] === outcome) return;
    if (row["state"] !== "claimed") conflict("A finished or uncertain ingress outcome cannot be overwritten");
    db.query("UPDATE ingress SET state = ? WHERE messageId = ?").run(outcome, messageId);
  });

  return {
    async addProject(input) {
      checkOpen();
      const guildId = text(input.guildId, "guildId");
      const channelId = text(input.channelId, "channelId");
      text(input.directory, "directory");
      let directory: string;
      let directoryIdentity: string;
      try {
        directory = await realpath(input.directory);
        const info = await stat(directory, { bigint: true });
        if (!info.isDirectory()) throw new Error("not a directory");
        directoryIdentity = `${info.dev}:${info.ino}`;
      } catch (error) {
        throw new DorimakiError("invalid_directory", `Project directory must exist: ${String(error)}`);
      }
      checkOpen();
      const project = { id: randomUUID(), guildId, channelId, directory };
      try {
        db.query("INSERT INTO projects (id, guildId, channelId, directory, directoryIdentity) VALUES (?, ?, ?, ?, ?)")
          .run(project.id, guildId, channelId, directory, directoryIdentity);
      } catch (error) {
        if (error instanceof Error && "code" in error &&
          typeof error.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT")) {
          conflict("Channel or canonical project directory is already registered");
        }
        throw error;
      }
      return project;
    },
    projects() {
      checkOpen();
      return db.query<Row, []>("SELECT * FROM projects ORDER BY rowid").all().map(projectRecord);
    },
    project(channelId) {
      checkOpen();
      const row = findProject.get(text(channelId, "channelId"));
      return row ? projectRecord(row) : undefined;
    },
    bind(input) {
      checkOpen();
      text(input.threadId, "threadId");
      text(input.projectId, "projectId");
      text(input.sessionId, "sessionId");
      text(input.sessionFile, "sessionFile");
      if (!isAbsolute(input.sessionFile) || typeof input.active !== "boolean") {
        throw new DorimakiError("invalid_record", "sessionFile must be absolute and active must be boolean");
      }
      bind.immediate(input);
    },
    conversation(threadId) {
      checkOpen();
      const row = findConversation.get(text(threadId, "threadId"));
      return row ? conversationRecord(row) : undefined;
    },
    conversations(projectId) {
      checkOpen();
      return db.query<Row, [string]>("SELECT * FROM conversations WHERE projectId = ? ORDER BY rowid")
        .all(text(projectId, "projectId")).map(conversationRecord);
    },
    retire(threadId) {
      checkOpen();
      db.query("UPDATE conversations SET active = 0 WHERE threadId = ?").run(text(threadId, "threadId"));
    },
    claimMessage(messageId) {
      checkOpen();
      return db.query("INSERT INTO ingress (messageId, state) VALUES (?, 'claimed') ON CONFLICT(messageId) DO NOTHING")
        .run(text(messageId, "messageId")).changes === 1;
    },
    finishMessage(messageId, outcome) {
      checkOpen();
      text(messageId, "messageId");
      if (outcome !== "completed" && outcome !== "failed" && outcome !== "uncertain") {
        throw new DorimakiError("invalid_record", "Invalid ingress outcome");
      }
      finish.immediate(messageId, outcome);
    },
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
  };
}
