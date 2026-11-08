// npm run bench            built-in extraction (free, deterministic)
// npm run bench -- --claude  use Claude for extraction (needs ANTHROPIC_API_KEY; costs a little)
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ClaudeLlm, hasClaudeCredentials } from "@agenticweb-dev/understand";
import { reportMarkdown, runBenchmark } from "./bench.ts";

const useClaude = process.argv.includes("--claude");
if (useClaude && !hasClaudeCredentials()) {
  console.error("--claude needs ANTHROPIC_API_KEY (or another Anthropic credential) in the environment.");
  process.exit(1);
}
const report = await runBenchmark({ llm: useClaude ? new ClaudeLlm() : undefined });
const md = reportMarkdown(report);
const dir = import.meta.dirname;
await writeFile(path.join(dir, `results-${report.mode}.md`), md);
await writeFile(path.join(dir, `results-${report.mode}.json`), JSON.stringify(report, null, 2));
console.log(md);
