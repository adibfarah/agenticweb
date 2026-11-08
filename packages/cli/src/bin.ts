#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Project, UserError } from "./project.ts";
import { cmdActions, cmdBuild, cmdInit, cmdSnippets, cmdStatus, cmdVerify, cmdVisibility } from "./commands.ts";
import { extraCommands } from "./extra.ts";

const HELP = `agenticweb: turn a website you own into an agent-ready site

Usage:
  agenticweb init <url> [--name "Business name"]   Start a project for your site
  agenticweb verify                               Check domain ownership
  agenticweb build [--no-llm] [--runtime]         Crawl, understand, and generate the agent branch
  agenticweb status                               Show what was found
  agenticweb actions [list|enable|disable] [name] Review and enable actions
  agenticweb hide|show <page-slug|entity-id>      Control what agents can see
  agenticweb snippets --base-url <url>            HTML/robots.txt snippets for your site
${extraCommands
  .map((c) => {
    const usage = `agenticweb ${c.usage}`;
    return usage.length < 47 ? `  ${usage.padEnd(48)}${c.summary}` : `  ${usage}\n  ${"".padEnd(48)}${c.summary}`;
  })
  .join("\n")}

Options:
  --dir <path>     Project folder (default: current folder)
  --help           Show this help
`;

/** Flags that take an optional value: a bare `--edge` must not swallow the next flag. */
const OPTIONAL_VALUE = new Set(["--edge"]);

async function main(rawArgv: string[]) {
  const argv = rawArgv.map((a, i) => (OPTIONAL_VALUE.has(a) && (rawArgv[i + 1] === undefined || rawArgv[i + 1]!.startsWith("-")) ? `${a}=` : a));
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      dir: { type: "string" },
      name: { type: "string" },
      force: { type: "boolean" },
      "no-llm": { type: "boolean" },
      runtime: { type: "boolean" },
      out: { type: "string" },
      "base-url": { type: "string" },
      target: { type: "string" },
      port: { type: "string" },
      every: { type: "string" },
      days: { type: "string" },
      "sync-every": { type: "string" },
      edge: { type: "string" },
      url: { type: "string" },
      min: { type: "string" },
      only: { type: "string" },
      init: { type: "boolean" },
      strict: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) {
    console.log(HELP);
    return;
  }
  const project = new Project((values.dir as string | undefined) ?? process.cwd());
  switch (cmd) {
    case "init":
      if (!rest[0]) throw new UserError("Usage: agenticweb init <url>");
      return cmdInit(project, rest[0], { name: values.name as string | undefined, force: Boolean(values.force) });
    case "verify":
      return cmdVerify(project);
    case "build":
      await cmdBuild(project, {
        llm: values["no-llm"] ? false : undefined,
        runtime: values.runtime as boolean | undefined,
        outDir: values.out as string | undefined,
        baseUrl: values["base-url"] as string | undefined,
      });
      return;
    case "status":
      return cmdStatus(project);
    case "actions":
      return cmdActions(project, rest[0], rest[1]);
    case "hide":
    case "show":
      return cmdVisibility(project, cmd === "hide", rest[0]);
    case "snippets":
      return cmdSnippets(project, values["base-url"] as string | undefined);
    default: {
      const extra = extraCommands.find((c) => c.name === cmd);
      if (extra) return extra.run(project, rest, values as Record<string, unknown>);
      throw new UserError(`Unknown command "${cmd}". Run agenticweb --help`);
    }
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UserError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err);
  process.exit(2);
});
