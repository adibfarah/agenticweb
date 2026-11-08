import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const NODE_BUILTINS = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
const REQUIRE_SHIM = 'import { createRequire as __agwRequire } from "node:module"; const require = __agwRequire(import.meta.url);';

/** node_modules folder holding AgenticWeb's dependencies (works from the repo and from an install). */
function depsDir(): string {
  const hono = fileURLToPath(import.meta.resolve("hono"));
  return hono.slice(0, hono.lastIndexOf("node_modules") + "node_modules".length);
}

export type RuntimeKind = "server" | "worker" | "edge-worker";

/** Folders of the third-party packages that ended up in a bundle (from esbuild's metafile). */
function bundledPackages(metafile: { inputs: Record<string, unknown> }): string[] {
  const dirs = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const p = path.resolve(input).split(path.sep).join("/");
    const i = p.lastIndexOf("/node_modules/");
    if (i < 0) continue;
    const parts = p.slice(i + "/node_modules/".length).split("/");
    const name = parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
    if (name.startsWith("@agenticweb-dev/")) continue;
    dirs.add(`${p.slice(0, i)}/node_modules/${name}`);
  }
  return [...dirs];
}

const MIT = (holder: string) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/**
 * The licenses of every third-party package in the bundles, as their licenses ask: name, license and the full
 * license text (plus any NOTICE file). Fails on a package with no license text we can reproduce.
 */
export function thirdPartyNotices(dirs: Iterable<string>, title = "AgenticWeb"): string {
  const entries = [...new Set(dirs)]
    .map((dir) => {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name: string;
        version: string;
        license?: string | { type?: string };
        author?: string | { name?: string };
        repository?: string | { url?: string };
        homepage?: string;
      };
      const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "UNKNOWN");
      const files = readdirSync(dir);
      const licenseFile = files.find((f) => /^(licen[cs]e|copying)(\.|$|-)/i.test(f));
      const noticeFile = files.find((f) => /^notice(\.|$)/i.test(f));
      let text = licenseFile ? readFileSync(path.join(dir, licenseFile), "utf8").trim() : "";
      if (!text) {
        const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
        if (license !== "MIT" || !author) throw new Error(`${pkg.name} has no license file to reproduce (license: ${license}). Check it before shipping.`);
        text = `(The package ships no license file. Its package.json says "${license}", author "${author}".)\n\n${MIT(author)}`;
      }
      const notice = noticeFile ? readFileSync(path.join(dir, noticeFile), "utf8").trim() : "";
      const repo = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? pkg.homepage ?? "");
      return { name: pkg.name, version: pkg.version, license, repo: repo.replace(/^git\+/, "").replace(/\.git$/, ""), text, notice };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const fence = (t: string) => "````text\n" + t + "\n````";
  return [
    "# Third-party notices",
    "",
    `${title} includes the following third-party software, bundled into its files. Each is used under its own license, reproduced below.`,
    "",
    "| Package | Version | License |",
    "|---|---|---|",
    ...entries.map((e) => `| ${e.name} | ${e.version} | ${e.license} |`),
    "",
    ...entries.flatMap((e) => [`## ${e.name} ${e.version}`, "", `License: ${e.license}${e.repo ? `. Source: ${e.repo}` : ""}`, "", fence(e.text), ...(e.notice ? ["", "NOTICE:", "", fence(e.notice)] : []), ""]),
  ].join("\n");
}

/** Where a bundle's notices file goes: next to it, named after it. */
export const noticesPathFor = (outfile: string) => `${outfile}.THIRD_PARTY_NOTICES.md`;

/**
 * Bundles one runtime entry (Node server or Cloudflare Worker) into a single file. Needs esbuild (dev only).
 * Returns the third-party packages inside it.
 */
export async function bundleRuntimeEntry(kind: RuntimeKind, outfile: string): Promise<string[]> {
  const esbuild = await import("esbuild");
  const entry = path.join(here, "..", "runtime-entries", `${kind}.ts`);
  const result = await esbuild.build({
    metafile: true,
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    nodePaths: [depsDir()],
    logLevel: "silent",
    legalComments: "none",
    ...(kind !== "server"
      ? {
          platform: "neutral",
          mainFields: ["module", "main"],
          conditions: ["workerd", "worker", "import", "default"],
          // Workers provide node:* modules with nodejs_compat; site-data.js is written at deploy time.
          external: [...NODE_BUILTINS, "./site-data.js"],
          target: "es2022",
        }
      : { platform: "node", target: "node22", banner: { js: REQUIRE_SHIM } }),
  });
  return bundledPackages(result.metafile);
}

/** Bundles the CLI itself into one file for npm. Returns the third-party packages inside it. */
export async function bundleCli(outfile: string): Promise<string[]> {
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    metafile: true,
    entryPoints: [path.join(here, "bin.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    nodePaths: [depsDir()],
    // Native or optional packages stay outside the bundle.
    external: ["esbuild", "playwright"],
    // bin.ts already starts with "#!/usr/bin/env node", which esbuild keeps as the first line.
    banner: { js: REQUIRE_SHIM },
    logLevel: "silent",
    // License texts go in THIRD_PARTY_NOTICES.md instead of comments scattered through the bundle.
    legalComments: "none",
  });
  return bundledPackages(result.metafile);
}
