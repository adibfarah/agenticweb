/** Minimal robots.txt parser: groups, Allow/Disallow with * and $ wildcards, Sitemap lines. */
export type Robots = {
  isAllowed: (path: string) => boolean;
  sitemaps: string[];
};

type Rule = { allow: boolean; pattern: string };

export const USER_AGENT = "AgenticWebBot/0.1 (+https://github.com/adibfarah/agenticweb)";
const AGENT_TOKEN = "agenticwebbot";

export function parseRobots(text: string): Robots {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[] } | undefined;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const m = line.match(/^([a-zA-Z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (key === "disallow" && value === "") continue; // empty Disallow means allow all
      current.rules.push({ allow: key === "allow", pattern: value });
    }
  }

  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && AGENT_TOKEN.includes(a)));
  const group = specific ?? groups.find((g) => g.agents.includes("*"));
  const rules = group?.rules ?? [];

  return {
    sitemaps,
    isAllowed(path: string) {
      let best: Rule | undefined;
      let bestLen = -1;
      for (const r of rules) {
        if (matches(r.pattern, path) && (r.pattern.length > bestLen || (r.pattern.length === bestLen && r.allow))) {
          best = r;
          bestLen = r.pattern.length;
        }
      }
      return best ? best.allow : true;
    },
  };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + body.split("*").map(escapeRe).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
