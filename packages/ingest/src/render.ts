import { USER_AGENT } from "./robots.ts";

/** Headless-browser renderer for JavaScript-heavy sites. Needs the optional `playwright` package. */
export async function createRenderer() {
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    throw new Error('Browser rendering needs Playwright. Run: npm install playwright && npx playwright install chromium');
  }
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ userAgent: USER_AGENT });
  return {
    async render(url: string): Promise<{ status: number; html: string; type: string }> {
      const page = await context.newPage();
      try {
        const res = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        // Open accordions so hidden answers are in the DOM text.
        await page.evaluate(() => document.querySelectorAll("details").forEach((d) => d.setAttribute("open", "")));
        return { status: res?.status() ?? 200, html: await page.content(), type: "text/html" };
      } finally {
        await page.close();
      }
    },
    close: () => browser.close(),
  };
}
