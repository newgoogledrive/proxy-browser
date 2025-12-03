/**
 * server.js
 * Simple server-side proxy that:
 *  - provides /meta for title + favicon
 *  - provides /asset to proxy binary assets
 *  - provides /proxy to fetch HTML and rewrite links to go through /asset and /proxy
 *
 * Note: This is intentionally simple. Do NOT expose this publicly without auth/rate-limits.
 */

const express = require('express');
const fetch = require('node-fetch'); // v2 — returns Node streams
const cheerio = require('cheerio');
const morgan = require('morgan');
const helmet = require('helmet');
//const rateLimit = require('express-rate-limit');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Security + logging
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('tiny'));

// Basic rate limiting
//app.use(rateLimit({
  //windowMs: 15 * 60 * 1000,
  //max: 200
//}));

// Serve frontend static files
app.use(express.static('public'));

// Helper to resolve absolute URLs safely
function absoluteUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch (e) {
    return null;
  }
}

/**
 * /meta?url=<url>
 * Returns JSON { title, favicon } used by the tab preview.
 */
app.get('/meta', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'missing url' });

  try {
    const r = await fetch(url, { redirect: 'follow', timeout: 10000 });
    const text = await r.text();
    const $ = cheerio.load(text);

    const title = $('meta[property="og:title"]').attr('content') || $('title').first().text() || url;

    // try several rel values for favicon
    let favicon = $('link[rel="icon"]').attr('href')
      || $('link[rel="shortcut icon"]').attr('href')
      || $('link[rel="apple-touch-icon"]').attr('href');

    if (favicon) {
      favicon = absoluteUrl(url, favicon);
    } else {
      // fallback to /favicon.ico
      try {
        const u = new URL(url);
        favicon = u.origin + '/favicon.ico';
      } catch {
        favicon = null;
      }
    }

    res.json({ title, favicon });
  } catch (err) {
    console.error('meta error', err && err.message);
    res.json({ title: url, favicon: null });
  }
});

/**
 * /asset?url=<url>
 * Proxies binary assets (images, scripts, css).
 * Streams the proxied response.
 */
app.get('/asset', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('No url');

  try {
    const r = await fetch(url, { redirect: 'follow', timeout: 20000 });

    // Forward content-type if present
    const ct = r.headers.get('content-type');
    if (ct) res.set('Content-Type', ct);

    // Stream Node fetch body (node-fetch v2 gives a Node stream)
    if (r.body && typeof r.body.pipe === 'function') {
      r.body.pipe(res);
    } else {
      // fallback: buffer
      const buf = await r.buffer();
      res.send(buf);
    }
  } catch (err) {
    console.error('asset error', err && err.message);
    res.status(500).send('Asset fetch failed');
  }
});

/**
 * /proxy?url=<url>
 * Main HTML proxy: fetch HTML, rewrite asset links and navigation so pages stay inside the proxy.
 */
app.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('No url');

  try {
    const r = await fetch(url, { redirect: 'follow', timeout: 20000 });
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      // If it's not HTML, just pipe via /asset logic
      const r2 = await fetch(url, { redirect: 'follow', timeout: 20000 });
      if (r2.body && typeof r2.body.pipe === 'function') return r2.body.pipe(res);
      const b = await r2.buffer();
      return res.send(b);
    }

    const html = await r.text();
    const $ = cheerio.load(html, { decodeEntities: false });
    const base = url;

    // rewrite <a> links to route back through /proxy (ignore anchors & javascript:)
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      if (href.startsWith('#') || href.startsWith('javascript:')) return;
      const abs = absoluteUrl(base, href);
      if (abs) $(el).attr('href', '/proxy?url=' + encodeURIComponent(abs));
    });

    // rewrite images/scripts/styles to /asset
    $('img[src]').each((i, el) => {
      const src = $(el).attr('src');
      const abs = absoluteUrl(base, src);
      if (abs) $(el).attr('src', '/asset?url=' + encodeURIComponent(abs));
    });

    $('script[src]').each((i, el) => {
      const src = $(el).attr('src');
      const abs = absoluteUrl(base, src);
      if (abs) $(el).attr('src', '/asset?url=' + encodeURIComponent(abs));
    });

    $('link[href]').each((i, el) => {
      const href = $(el).attr('href');
      const rel = ($(el).attr('rel') || '').toLowerCase();
      const abs = absoluteUrl(base, href);
      if (!abs) return;
      // For stylesheets/images, route via /asset; for canonical/page links, route via /proxy
      if (rel === 'stylesheet' || /\.(css)$/i.test(abs.split('?')[0])) {
        $(el).attr('href', '/asset?url=' + encodeURIComponent(abs));
      } else {
        $(el).attr('href', '/proxy?url=' + encodeURIComponent(abs));
      }
    });

    // inline style url(...) rewrite
    $('[style]').each((i, el) => {
      let style = $(el).attr('style');
      if (!style) return;
      style = style.replace(/url\((['"]?)(.*?)\1\)/g, (m, q, inner) => {
        const abs = absoluteUrl(base, inner);
        if (!abs) return m;
        return `url('/asset?url=${encodeURIComponent(abs)}')`;
      });
      $(el).attr('style', style);
    });

    // rewrite srcset
    $('img[srcset]').each((i, el) => {
      const srcset = $(el).attr('srcset');
      if (!srcset) return;
      const parts = srcset.split(',').map(p => p.trim()).map(p => {
        const [u, descriptor] = p.split(/\s+/);
        const abs = absoluteUrl(base, u);
        if (!abs) return p;
        return `/asset?url=${encodeURIComponent(abs)}` + (descriptor ? ' ' + descriptor : '');
      });
      $(el).attr('srcset', parts.join(', '));
    });

    // inject a small top banner so proxied pages know they're proxied (optional)
    $('body').prepend(`<div style="position:fixed;left:0;right:0;top:0;background:rgba(0,0,0,0.55);color:#fff;padding:6px;z-index:99999;font-family:system-ui;font-size:12px;">Proxied via In-Browser Proxy — <a href="${base}" style="color:#9cf;" target="_blank" rel="noopener noreferrer">Open original</a></div>`);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send($.html());
  } catch (err) {
    console.error('proxy error', err && err.message);
    res.status(500).send('Proxy failed');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Proxy server listening on http://localhost:${PORT}`);
});
