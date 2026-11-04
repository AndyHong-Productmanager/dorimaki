import { rm } from "node:fs/promises";
import type { CatalogEntry, EngineSession, Project } from "./contracts.js";
import type { Dependencies } from "./conversations.js";

/** Guild shortcuts are a union; execution always resolves against its project. */
export class Catalogs {
  private readonly projects = new Map<string, readonly CatalogEntry[]>();

  constructor(private readonly dependencies: Dependencies) {}

  entries(projectId: string): readonly CatalogEntry[] {
    return this.projects.get(projectId) ?? [];
  }

  async initialize(): Promise<void> {
    for (const project of this.dependencies.store.projects()) {
      const session = await this.dependencies.engine.open({
        directory: project.directory, mode: { kind: "create" },
      });
      try {
        await this.refresh(project, session);
      } finally {
        try {
          await session.close();
        } finally {
          await rm(session.identity.sessionFile, { force: true });
        }
      }
    }
  }

  async refresh(project: Project, session: EngineSession): Promise<void> {
    this.projects.set(project.id, await session.catalog());
    const combined = new Map<string, CatalogEntry>();
    for (const entries of this.projects.values()) {
      for (const entry of entries) {
        combined.set(`${entry.kind}:${entry.name}`, entry);
      }
    }
    await this.dependencies.discord.registerCatalog([...combined.values()]);
  }
}
