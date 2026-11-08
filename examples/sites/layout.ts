/** Shared HTML shell for demo sites. Deliberately includes the clutter real sites have. */
export function layout(opts: {
  siteName: string;
  title: string;
  description?: string;
  nav: Array<[string, string]>;
  body: string;
  footer: string;
  head?: string;
}): string {
  const nav = opts.nav.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} | ${opts.siteName}</title>
${opts.description ? `<meta name="description" content="${opts.description}">` : ""}
<link rel="stylesheet" href="/static/site.css">
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());</script>
<script async src="/static/tracker.js"></script>
${opts.head ?? ""}
</head>
<body>
<div class="cookie-banner" id="cookies">We use cookies to improve your experience. <button>Accept all</button> <button>Settings</button></div>
<header class="site-header">
  <a class="logo" href="/"><img src="/static/logo.png" alt="${opts.siteName} logo"></a>
  <nav aria-label="Main"><ul>${nav}</ul></nav>
  <button class="hamburger" aria-label="Open menu">☰</button>
</header>
<main>
${opts.body}
</main>
<footer class="site-footer">
${opts.footer}
<p class="legal">© 2026 ${opts.siteName}. All rights reserved. <a href="/privacy">Privacy</a></p>
</footer>
<div class="chat-widget"><iframe src="about:blank" title="Live chat"></iframe></div>
<script>document.querySelector('.hamburger').onclick=function(){document.body.classList.toggle('nav-open')}</script>
</body>
</html>`;
}

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
