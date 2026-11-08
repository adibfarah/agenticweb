// Builds the publishable `agenticweb` package: one CLI file plus pre-built runtimes.
//   npm run build
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundleCli, bundleRuntimeEntry, thirdPartyNotices } from "../packages/cli/src/bundle.ts";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "packages", "cli", "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "runtime"), { recursive: true });
const cliDeps = await bundleCli(path.join(dist, "agenticweb.mjs"));
const runtimeDeps = [
  ...(await bundleRuntimeEntry("server", path.join(dist, "runtime", "server.mjs"))),
  ...(await bundleRuntimeEntry("worker", path.join(dist, "runtime", "worker.js"))),
  ...(await bundleRuntimeEntry("edge-worker", path.join(dist, "runtime", "edge-worker.js"))),
];
// The bundled packages' licenses ask for their notices to travel with every copy.
await writeFile(path.join(dist, "THIRD_PARTY_NOTICES.md"), thirdPartyNotices([...cliDeps, ...runtimeDeps], "The agenticweb package"));
// Deploys copy the runtime into the owner's folder; these notices go with it.
await writeFile(path.join(dist, "runtime", "THIRD_PARTY_NOTICES.md"), thirdPartyNotices(runtimeDeps, "The AgenticWeb runtime"));
await copyFile(path.join(root, "README.md"), path.join(root, "packages", "cli", "README.md"));
await copyFile(path.join(root, "LICENSE"), path.join(root, "packages", "cli", "LICENSE")).catch(() => {});

for (const f of ["agenticweb.mjs", "runtime/server.mjs", "runtime/worker.js", "runtime/edge-worker.js"]) {
  const s = await stat(path.join(dist, f));
  console.log(`${f.padEnd(22)} ${(s.size / 1024).toFixed(0)} KB`);
}
console.log("Built packages/cli/dist. Publish with: npm publish -w packages/cli");
