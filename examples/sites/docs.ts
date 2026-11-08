import { esc, layout } from "./layout.ts";

/** Ground truth for the demo docs site (a small SaaS API). */
export const docs = {
  name: "Acme Notify",
  description: "Acme Notify sends SMS and email notifications through one API.",
  pages: [
    {
      path: "/docs/",
      title: "Introduction",
      html: `<h1>Introduction</h1><p>Acme Notify sends SMS and email notifications through one REST API. Base URL: <code>https://api.acmenotify.example/v2</code>.</p>`,
    },
    {
      path: "/docs/authentication",
      title: "Authentication",
      html: `<h1>Authentication</h1><p>Send your API key in the <code>Authorization: Bearer &lt;key&gt;</code> header. Keys starting with <code>test_</code> never send real messages.</p>`,
    },
    {
      path: "/docs/send-message",
      title: "Send a message",
      html: `<h1>Send a message</h1><p><code>POST /messages</code> with JSON body:</p>
<pre><code>{ "to": "+15035550100", "channel": "sms", "body": "Your table is ready" }</code></pre>
<p>Channels: <code>sms</code>, <code>email</code>. SMS bodies are limited to 480 characters.</p>`,
    },
    {
      path: "/docs/rate-limits",
      title: "Rate limits",
      html: `<h1>Rate limits</h1><table><thead><tr><th>Plan</th><th>Requests per minute</th></tr></thead>
<tbody><tr><td>Free</td><td>60</td></tr><tr><td>Pro</td><td>600</td></tr><tr><td>Enterprise</td><td>Custom</td></tr></tbody></table>`,
    },
    {
      path: "/pricing",
      title: "Pricing",
      html: `<h1>Pricing</h1><ul><li>Free: 100 messages per month</li><li>Pro: $49 per month, includes 10,000 messages, then $0.004 per message</li><li>Enterprise: contact sales</li></ul>`,
    },
  ],
};

export function docsPages(): Record<string, string> {
  const nav: Array<[string, string]> = docs.pages.map((p) => [p.path, esc(p.title)]);
  const out: Record<string, string> = {
    "/": layout({
      siteName: docs.name,
      title: "Home",
      description: docs.description,
      nav,
      footer: "<p>Status: all systems operational</p>",
      body: `<h1>Acme Notify</h1><p>${docs.description}</p><a href="/docs/">Read the docs</a>`,
    }),
  };
  for (const p of docs.pages) {
    out[p.path] = layout({
      siteName: docs.name,
      title: p.title,
      nav,
      footer: "<p>Status: all systems operational</p>",
      body: `<div class="docs-layout"><aside class="sidebar">${nav.map(([h, l]) => `<a href="${h}">${l}</a>`).join("")}</aside><article>${p.html}</article></div>`,
    });
  }
  return out;
}
