import { describe, expect, it } from "vitest";
import { reportMarkdown, runBenchmark } from "../bench.ts";

describe("benchmark", () => {
  it("shows the agent branch doing more with far fewer tokens", async () => {
    const r = await runBenchmark();
    expect(r.totals.agent.success).toBeGreaterThanOrEqual(r.totals.human.success);
    expect(r.totals.agent.tokens).toBeLessThan(r.totals.human.tokens / 3);
    expect(r.totals.agent.requests).toBeLessThan(r.totals.human.requests);
    expect(reportMarkdown(r)).toContain("fewer tokens");
  }, 60_000);
});
