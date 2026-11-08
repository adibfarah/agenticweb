import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProjectConfig, SiteGraph, type Ownership } from "@agenticweb-dev/core";

export const CONFIG_FILE = "agenticweb.config.json";
export const STATE_DIR = ".agenticweb";

/** Local state that never gets published (verification token, last build). */
export type ProjectState = {
  verifyToken: string;
  ownership?: Ownership;
  lastBuild?: string;
};

export class Project {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  get configPath() {
    return path.join(this.dir, CONFIG_FILE);
  }
  get statePath() {
    return path.join(this.dir, STATE_DIR, "state.json");
  }
  get graphPath() {
    return path.join(this.dir, STATE_DIR, "site-graph.json");
  }
  get dataDir() {
    return path.join(this.dir, STATE_DIR);
  }

  exists(): boolean {
    return existsSync(this.configPath);
  }

  async config(): Promise<ProjectConfig> {
    if (!this.exists()) throw new UserError(`No ${CONFIG_FILE} here. Run: agenticweb init <your-site-url>`);
    return ProjectConfig.parse(JSON.parse(await readFile(this.configPath, "utf8")));
  }

  async saveConfig(c: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.configPath, JSON.stringify(c, null, 2) + "\n");
  }

  async state(): Promise<ProjectState> {
    return JSON.parse(await readFile(this.statePath, "utf8")) as ProjectState;
  }

  async saveState(s: ProjectState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(s, null, 2) + "\n");
  }

  async graph(): Promise<SiteGraph | undefined> {
    if (!existsSync(this.graphPath)) return undefined;
    return SiteGraph.parse(JSON.parse(await readFile(this.graphPath, "utf8")));
  }

  async requireGraph(): Promise<SiteGraph> {
    const g = await this.graph();
    if (!g) throw new UserError("Nothing built yet. Run: agenticweb build");
    return g;
  }

  async saveGraph(g: SiteGraph): Promise<void> {
    await mkdir(path.dirname(this.graphPath), { recursive: true });
    await writeFile(this.graphPath, JSON.stringify(g, null, 2) + "\n");
  }
}

/** Writes emitted files into a directory, replacing what was there. */
export async function writeFiles(outDir: string, files: Map<string, string>): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  for (const [rel, content] of files) {
    const target = path.join(outDir, ...rel.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/** An error meant for the person running the CLI: printed without a stack trace. */
export class UserError extends Error {}
