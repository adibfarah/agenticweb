import { describe, expect, it } from "vitest";
import { SiteGraph } from "@agenticweb-dev/core";
import { createReviewApp } from "../src/index.ts";

const seen = "2026-11-07T00:00:00Z";
function store() {
  let g = SiteGraph.parse({
    site: { name: "Cafe", url: "https://cafe.test" },
    generatedAt: seen,
    pages: [{ slug: "menu", url: "https://cafe.test/menu", title: "Menu", markdown: "x", hash: "1", updated: seen, source: { via: "crawl", seen } }],
    actions: [{ name: "book", description: "Book", kind: "write", backend: { type: "demo", operation: "x" }, source: { via: "heuristic", seen } }],
  });
  const changes: unknown[] = [];
  return {
    changes,
    get: () => g,
    s: { load: async () => structuredClone(g), save: async (n: SiteGraph) => void (g = n), onActionChange: async (name: string, c: unknown) => void changes.push([name, c]) },
  };
}
const call = (app: ReturnType<typeof createReviewApp>, path: string, body?: unknown, token = "tok") =>
  app.fetch(new Request(`http://127.0.0.1${path}`, { method: body ? "POST" : "GET", headers: { "x-review-token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));

describe("review app", () => {
  it("requires the token", async () => {
    const st = store();
    const app = createReviewApp(st.s, "tok");
    expect((await call(app, "/api/graph", undefined, "wrong")).status).toBe(403);
    expect((await app.fetch(new Request("http://127.0.0.1/"))).status).toBe(403);
    expect((await app.fetch(new Request("http://127.0.0.1/?token=tok"))).status).toBe(200);
  });

  it("hides pages and enables actions", async () => {
    const st = store();
    const app = createReviewApp(st.s, "tok");
    await call(app, "/api/pages/menu", { hidden: true });
    expect(st.get().pages[0]!.hidden).toBe(true);
    await call(app, "/api/actions/book", { enabled: true, confirmation: "owner" });
    expect(st.get().actions[0]).toMatchObject({ enabled: true, confirmation: "owner" });
    expect(st.changes).toEqual([["book", { enabled: true, confirmation: "owner" }]]);
    expect((await call(app, "/api/actions/book", { confirmation: "yolo" })).status).toBe(400);
  });
});

describe("review page", () => {
  it("ships a script that parses", async () => {
    const { reviewHtml } = await import("../src/page.ts");
    const js = reviewHtml("t").split("<script>")[1]!.split("</script>")[0]!;
    expect(() => new Function(js)).not.toThrow();
  });

  it("lets the owner edit, approve and dismiss suggestions", async () => {
    const st = store();
    const updates: unknown[] = [];
    const app = createReviewApp(
      {
        ...st.s,
        suggestions: async () => [{ id: "s1", question: "Parking?" }],
        updateSuggestion: async (id, change) => {
          updates.push([id, change]);
          if (change.status === "approved" && change.draft?.includes("[[")) throw new Error("Fill in the blanks first.");
          return { id, ...change };
        },
      },
      "tok",
    );
    expect(await (await call(app, "/api/suggestions")).json()).toEqual([{ id: "s1", question: "Parking?" }]);
    expect((await call(app, "/api/suggestions/s1", { draft: "[[fill in: x]]", status: "approved" })).status).toBe(400);
    expect((await call(app, "/api/suggestions/s1", { status: "maybe" })).status).toBe(400);
    expect((await call(app, "/api/suggestions/s1", { draft: "Free after 6pm", status: "approved" })).status).toBe(200);
    expect(updates.at(-1)).toEqual(["s1", { draft: "Free after 6pm", status: "approved" }]);
    expect((await call(app, "/api/suggestions/refresh", {})).status).toBe(404);
  });
});
