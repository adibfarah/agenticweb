import { Hono } from "hono";
import { Confirmation, type SiteGraph } from "@agenticweb-dev/core";
import { reviewHtml } from "./page.ts";

export type ReviewStore = {
  load: () => Promise<SiteGraph>;
  save: (g: SiteGraph) => Promise<void>;
  /** Called when the owner enables/disables or edits an action, so the choice can go in the config file. */
  onActionChange?: (name: string, change: { enabled?: boolean; confirmation?: string; description?: string }) => Promise<void>;
  /** Agent-traffic summary for the Activity tab. */
  activity?: (days: number) => Promise<unknown>;
  /** Recent sync change reports, newest first. */
  changes?: () => Promise<unknown[]>;
  /** Drafted answers for questions the site couldn't answer (Suggestions tab). */
  suggestions?: () => Promise<unknown[]>;
  updateSuggestion?: (id: string, change: { draft?: string; question?: string; status?: "approved" | "dismissed" | "new" }) => Promise<unknown>;
  /** Looks for new gaps and drafts suggestions for them. */
  refreshSuggestions?: () => Promise<{ added: number }>;
};

/**
 * Local review UI. Bind it to 127.0.0.1 only. Every API call needs the session token,
 * so other websites open in the browser can't change anything.
 */
export function createReviewApp(store: ReviewStore, token: string): Hono {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    if (c.req.header("x-review-token") !== token) return c.json({ error: "Missing or wrong review token." }, 403);
    await next();
  });

  app.get("/", (c) => {
    if (c.req.query("token") !== token) return c.text("Open the link printed by `agenticweb review`.", 403);
    return c.html(reviewHtml(token));
  });

  app.get("/api/graph", async (c) => c.json(await store.load()));
  app.get("/api/activity", async (c) => c.json((await store.activity?.(Number(c.req.query("days") ?? 7))) ?? null));
  app.get("/api/changes", async (c) => c.json((await store.changes?.()) ?? []));
  app.get("/api/suggestions", async (c) => c.json((await store.suggestions?.()) ?? []));
  app.post("/api/suggestions/refresh", async (c) => {
    if (!store.refreshSuggestions) return c.json({ error: "Not available" }, 404);
    return c.json(await store.refreshSuggestions());
  });
  app.post("/api/suggestions/:id", async (c) => {
    if (!store.updateSuggestion) return c.json({ error: "Not available" }, 404);
    const body = (await c.req.json()) as { draft?: unknown; question?: unknown; status?: unknown };
    const status = body.status === "approved" || body.status === "dismissed" || body.status === "new" ? body.status : undefined;
    if (body.status !== undefined && !status) return c.json({ error: "Unknown status" }, 400);
    try {
      const s = await store.updateSuggestion(c.req.param("id"), {
        ...(typeof body.draft === "string" ? { draft: body.draft } : {}),
        ...(typeof body.question === "string" ? { question: body.question } : {}),
        ...(status ? { status } : {}),
      });
      return c.json(s);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post("/api/pages/:slug", async (c) => {
    const { hidden } = (await c.req.json()) as { hidden: boolean };
    const g = await store.load();
    const p = g.pages.find((x) => x.slug === c.req.param("slug"));
    if (!p) return c.json({ error: "No such page" }, 404);
    p.hidden = Boolean(hidden);
    await store.save(g);
    return c.json({ ok: true });
  });

  app.post("/api/entities", async (c) => {
    const { id, hidden } = (await c.req.json()) as { id: string; hidden: boolean };
    const g = await store.load();
    const e = g.entities.find((x) => x.id === id);
    if (!e) return c.json({ error: "No such item" }, 404);
    e.hidden = Boolean(hidden);
    await store.save(g);
    return c.json({ ok: true });
  });

  app.post("/api/actions/:name", async (c) => {
    const body = (await c.req.json()) as { enabled?: boolean; confirmation?: string; description?: string };
    const g = await store.load();
    const a = g.actions.find((x) => x.name === c.req.param("name"));
    if (!a) return c.json({ error: "No such action" }, 404);
    const change: { enabled?: boolean; confirmation?: string; description?: string } = {};
    if (typeof body.enabled === "boolean") a.enabled = change.enabled = body.enabled;
    if (body.confirmation !== undefined) {
      const parsed = Confirmation.safeParse(body.confirmation);
      if (!parsed.success) return c.json({ error: "Unknown confirmation level" }, 400);
      a.confirmation = parsed.data;
      change.confirmation = parsed.data;
    }
    if (typeof body.description === "string" && body.description.trim()) a.description = change.description = body.description.trim();
    await store.save(g);
    await store.onActionChange?.(a.name, change);
    return c.json({ ok: true });
  });

  app.post("/api/site", async (c) => {
    const body = (await c.req.json()) as { name?: string; description?: string };
    const g = await store.load();
    if (body.name?.trim()) g.site.name = body.name.trim();
    if (typeof body.description === "string") g.site.description = body.description.trim();
    await store.save(g);
    return c.json({ ok: true });
  });

  return app;
}
