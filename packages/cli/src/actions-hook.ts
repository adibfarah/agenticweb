import { appendFile } from "node:fs/promises";
import path from "node:path";
import { createEngine, createNotifier, parseApiKeys, syncSources } from "@agenticweb-dev/actions";
import { FileStore } from "@agenticweb-dev/actions/file-store";
import type { ProjectConfig } from "@agenticweb-dev/core";
import { Project } from "./project.ts";
import { serveHooks } from "./serve.ts";

/** Local engine for `agenticweb serve`: records in .agenticweb/actions.json, test emails in .agenticweb/outbox.log. */
serveHooks.engine = async (project, graph, config) => {
  if (!graph.actions.some((a) => a.enabled)) return undefined;
  const outbox = path.join(project.dataDir, "outbox.log");
  const notifier = createNotifier(config, process.env, {
    outboxSink: async (n) => {
      const line = `[${new Date().toISOString()}] To: ${n.to}\nSubject: ${n.subject}\n${n.text}\n\n`;
      await appendFile(outbox, line);
      console.log(`\n[outbox] Message to ${n.to}: ${n.subject}${n.link ? `\n         ${n.link}` : ""}\n`);
    },
  });
  return createEngine({ graph, config, env: process.env, store: new FileStore(path.join(project.dataDir, "actions.json")), notifier });
};

export const apiKeysFrom = (config: ProjectConfig) => parseApiKeys(process.env[config.runtime.apiKeysEnv]);

/** Default build-time connector sync: every source in agenticweb.config.json. */
export async function defaultConnectors(config: ProjectConfig, log: (m: string) => void) {
  if (!config.sources.length) return { entities: [], actions: [] };
  return syncSources(config, { env: process.env, log });
}

export type { Project };
