// Медіа Дотичне — серверна частина сайту (Cloudflare Worker).
// 1) /article.html?id=…  → вставляє статтю з Notion прямо в HTML (для Google і прев'ю в соцмережах)
// 2) /sitemap.xml        → генерує карту сайту з усіма опублікованими статтями
// 3) /team, /team/*      → закритий розділ для співробітників (вхід за поштою і паролем)
// Усе інше віддається як звичайні статичні файли.
//
// Потрібні змінні середовища воркера: NOTION_TOKEN (Secret), NOTION_DB_ID (Text),
// TEAM_USERS (Secret, пошти й паролі), SESSION_SECRET (Secret) та KV-сховище TEAM_KV.

const SITE = 'https://dotychne.online';
const SITE_NAME = 'Медіа Дотичне';
const DEFAULT_IMAGE = `${SITE}/og-image.png`;
const NOTION_VERSION = '2022-06-28';
const CACHE_SECONDS = 600; // 10 хвилин

const UK_MONTHS = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Закритий розділ для співробітників. Перевіряємо вхід ДО будь-чого іншого.
    if (path === '/team' || path.startsWith('/team/')) {
      return team(request, env, url, path);
    }

    try {
      if (path === '/sitemap.xml') {
        return await cached(request, ctx, () => sitemap(env));
      }
      if ((path === '/article' || path === '/article.html') && url.searchParams.get('id')) {
        return await cached(request, ctx, () => articlePage(request, env, url));
      }
    } catch (err) {
      console.error('SSR error:', err && err.message);
      // Якщо щось пішло не так — віддаємо звичайну сторінку, сайт не ламається
    }
    return env.ASSETS.fetch(request);
  },
};

// ── Кеш, щоб не звертатися до Notion на кожен перегляд ──
async function cached(request, ctx, make) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.status === 200) {
    const copy = new Response(res.body, res);
    copy.headers.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
    ctx.waitUntil(cache.put(key, copy.clone()));
    return copy;
  }
  return res;
}

// ── Notion API ──
async function notion(env, path, body) {
  const base = env.NOTION_API_BASE || 'https://api.notion.com/v1';
  const res = await fetch(`${base}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion ${path}: HTTP ${res.status}`);
  return res.json();
}

async function publishedPages(env) {
  const out = [];
  let cursor;
  do {
    const data = await notion(env, `databases/${env.NOTION_DB_ID}/query`, {
      filter: { property: 'Published', checkbox: { equals: true } },
      sorts: [{ property: 'Date', direction: 'descending' }],
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    out.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor && out.length < 2000);
  return out;
}

async function allBlocks(env, pageId) {
  const out = [];
  let cursor;
  do {
    const qs = `page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const data = await notion(env, `blocks/${pageId}/children?${qs}`);
    out.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor && out.length < 1000);
  return out;
}

// ── Поля статті (ті самі, що читає сайт у браузері) ──
function fields(page) {
  const p = page.properties || {};
  const text = (prop) => (prop?.rich_text || []).map((r) => r.plain_text).join('');
  return {
    id: page.id,
    title: (p.Title?.title || p.Name?.title || []).map((r) => r.plain_text).join('') || 'Без назви',
    excerpt: text(p.Excerpt),
    category: p.Category?.select?.name || '',
    author: text(p.Author) || (p.Author?.people || []).map((u) => u.name).filter(Boolean).join(', ') || 'Редакція',
    date: p.Date?.date?.start || '',
    edited: page.last_edited_time || '',
    published: p.Published?.checkbox === true,
    cover: page.cover?.external?.url || page.cover?.file?.url || '',
  };
}

// ── Sitemap ──
async function sitemap(env) {
  const pages = await publishedPages(env);
  const staticUrls = [
    { loc: `${SITE}/`, freq: 'weekly', pr: '1.0' },
    { loc: `${SITE}/articles`, freq: 'daily', pr: '0.9' },
    { loc: `${SITE}/about`, freq: 'monthly', pr: '0.8' },
  ];
  const rows = staticUrls.map((u) =>
    `  <url>\n    <loc>${u.loc}</loc>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.pr}</priority>\n  </url>`);
  for (const page of pages) {
    const f = fields(page);
    const lastmod = (f.edited || f.date || '').slice(0, 10);
    rows.push(`  <url>\n    <loc>${SITE}/article.html?id=${f.id}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}

// ── Сторінка статті ──
async function articlePage(request, env, url) {
  const id = url.searchParams.get('id');
  if (!/^[0-9a-f-]{32,36}$/i.test(id)) return env.ASSETS.fetch(request);

  // Шаблон article.html
  const tplUrl = new URL('/article.html', url);
  let tpl = await env.ASSETS.fetch(new Request(tplUrl, { method: 'GET' }));
  if (tpl.status >= 300 && tpl.status < 400) {
    const loc = tpl.headers.get('Location');
    tpl = await env.ASSETS.fetch(new Request(new URL(loc, tplUrl), { method: 'GET' }));
  }
  if (!tpl.ok) return env.ASSETS.fetch(request);

  const [page, blocks] = await Promise.all([
    notion(env, `pages/${id}`),
    allBlocks(env, id),
  ]);
  const a = fields(page);
  if (!a.published) return env.ASSETS.fetch(request); // неопубліковане не віддаємо пошуковикам

  const canonical = `${SITE}/article.html?id=${a.id}`;
  const fullTitle = `${a.title} — ${SITE_NAME}`;
  const description = (a.excerpt || plainText(blocks).slice(0, 180) || a.title).trim();
  const image = a.cover || DEFAULT_IMAGE;
  const contentHtml = blocksToHtml(blocks);
  const words = (plainText(blocks) || a.excerpt).trim().split(/\s+/).filter(Boolean).length;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: a.title.slice(0, 110),
    description,
    image: [image],
    datePublished: a.date || undefined,
    dateModified: a.edited || a.date || undefined,
    author: a.author.split(',').map((n) => ({ '@type': 'Person', name: n.trim() })),
    publisher: {
      '@type': 'Organization',
      name: 'ГО «Медіа Дотичне»',
      url: SITE,
      logo: { '@type': 'ImageObject', url: `${SITE}/apple-touch-icon.png` },
    },
    mainEntityOfPage: canonical,
    articleSection: a.category || undefined,
    inLanguage: 'uk',
  };

  const headExtra = `
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
${a.date ? `<meta property="article:published_time" content="${esc(a.date)}">` : ''}
${a.category ? `<meta property="article:section" content="${esc(a.category)}">` : ''}
<meta name="twitter:title" content="${esc(fullTitle)}">
<meta name="twitter:description" content="${esc(description)}">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
<script>window.__SSR_ARTICLE__ = true;</script>
`;

  const setText = (value) => ({ element(el) { el.setInnerContent(value); } });

  const rewriter = new HTMLRewriter()
    .on('title', setText(fullTitle))
    .on('meta[name="description"]', { element(el) { el.setAttribute('content', description); } })
    .on('meta[property="og:image"]', { element(el) { el.setAttribute('content', image); } })
    .on('meta[name="twitter:image"]', { element(el) { el.setAttribute('content', image); } })
    .on('head', { element(el) { el.append(headExtra, { html: true }); } })
    .on('#loadingState', { element(el) { el.setAttribute('style', 'display:none'); } })
    .on('#articleEl', { element(el) { el.setAttribute('style', 'display:block'); } })
    .on('#articleCategory', setText(a.category))
    .on('#articleTitle', setText(a.title))
    .on('#articleExcerpt', setText(a.excerpt))
    .on('#authorAvatar', setText(initials(a.author)))
    .on('#authorName', setText(a.author))
    .on('#authorDate', setText(formatDate(a.date)))
    .on('#readTime', setText(`${Math.max(1, Math.round(words / 200))} хв читання`))
    .on('#articleCover', {
      element(el) {
        if (a.cover) {
          el.setAttribute('src', a.cover);
          el.setAttribute('alt', a.title);
          el.setAttribute('style', 'display:block');
        }
      },
    })
    .on('#articleContent', { element(el) { el.setInnerContent(contentHtml, { html: true }); } })
    .on('#articleTags', {
      element(el) {
        if (a.category) el.setInnerContent(`<a href="articles.html" class="article-tag">${esc(a.category)}</a>`, { html: true });
      },
    });

  const res = rewriter.transform(tpl);
  const headers = new Headers(res.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.delete('ETag');
  headers.delete('Content-Length');
  return new Response(res.body, { status: 200, headers });
}

// ── Хелпери ──
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  if (isNaN(d)) return '';
  return `${d.getUTCDate()} ${UK_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function initials(name) {
  if (!name) return '?';
  return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
}

function plainText(blocks) {
  return blocks.map((b) => (b[b.type]?.rich_text || []).map((r) => r.plain_text).join('')).join(' ');
}

function richToHtml(rich) {
  return (rich || []).map((r) => {
    let t = esc(r.plain_text);
    if (r.annotations?.bold) t = `<strong>${t}</strong>`;
    if (r.annotations?.italic) t = `<em>${t}</em>`;
    if (r.annotations?.code) t = `<code>${t}</code>`;
    if (r.href) t = `<a href="${esc(r.href)}" target="_blank" rel="noopener">${t}</a>`;
    return t;
  }).join('');
}

// Та сама логіка, що й у article.html, щоб вигляд не змінювався
function blocksToHtml(blocks) {
  let html = '';
  for (const block of blocks) {
    const type = block.type;
    const text = richToHtml(block[type]?.rich_text);
    switch (type) {
      case 'paragraph': if (text) html += `<p>${text}</p>`; break;
      case 'heading_1': html += `<h2>${text}</h2>`; break;
      case 'heading_2': html += `<h2>${text}</h2>`; break;
      case 'heading_3': html += `<h3>${text}</h3>`; break;
      case 'bulleted_list_item': html += `<ul><li>${text}</li></ul>`; break;
      case 'numbered_list_item': html += `<ol><li>${text}</li></ol>`; break;
      case 'quote': html += `<blockquote>${text}</blockquote>`; break;
      case 'divider': html += `<hr>`; break;
      case 'callout': {
        const icon = block.callout?.icon?.emoji || '💡';
        html += `<div class="notion-callout"><span class="notion-callout-icon">${icon}</span><div class="notion-callout-text">${text}</div></div>`;
        break;
      }
      case 'image': {
        const src = block.image?.external?.url || block.image?.file?.url || '';
        const cap = (block.image?.caption || []).map((r) => r.plain_text).join('');
        if (src) html += `<figure style="margin:40px 0"><img src="${esc(src)}" alt="${esc(cap)}" style="width:100%;opacity:0.85"><figcaption style="font-size:12px;color:var(--gray);margin-top:10px;letter-spacing:0.04em">${esc(cap)}</figcaption></figure>`;
        break;
      }
    }
  }
  return html.replace(/<\/ul>\s*<ul>/g, '').replace(/<\/ol>\s*<ol>/g, '');
}

// ── Закритий розділ /team ──
// Вхід за поштою і сталим паролем. Список людей — у секреті TEAM_USERS:
//   {"media.dotychne@gmail.com": "довгий-пароль", "ім'я@пошта": "інший-пароль"}
// Після входу браузер отримує підписану куку на 30 днів.

const SESSION_DAYS = 30;
const MAX_FAILS = 5;          // спроб поспіль
const LOCK_MINUTES = 15;      // блокування після них

async function team(request, env, url, path) {
  if (path === '/team/login') return teamLogin(request, env, url);
  if (path === '/team/logout') {
    return new Response(null, { status: 302, headers: { Location: '/team/login', 'Set-Cookie': cookie('', 0) } });
  }
  const who = await sessionUser(request, env);
  if (!who) {
    if (path === '/team/api/storage') return noStore(new Response('потрібен вхід', { status: 401 }));
    return new Response(null, { status: 302, headers: { Location: '/team/login', 'Cache-Control': 'no-store' } });
  }
  const res = path === '/team/api/storage' ? await teamStorage(request, env, url, who) : await env.ASSETS.fetch(request);
  return noStore(new Response(res.body, res));
}

function noStore(res) {
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

function users(env) {
  try { const u = JSON.parse(env.TEAM_USERS || '{}'); const out = {}; for (const k in u) out[k.trim().toLowerCase()] = String(u[k]); return out; }
  catch (e) { return {}; }
}

async function teamLogin(request, env, url) {
  let error = '';
  let email = '';
  if (request.method === 'POST') {
    const form = await request.formData();
    email = String(form.get('email') || '').trim().toLowerCase();
    const pass = String(form.get('password') || '');
    const lockKey = 'lock:' + email;
    const fails = env.TEAM_KV ? Number(await env.TEAM_KV.get(lockKey)) || 0 : 0;
    const list = users(env);
    if (!env.SESSION_SECRET || !Object.keys(list).length) {
      error = 'Вхід ще не налаштовано.';
    } else if (fails >= MAX_FAILS) {
      error = `Забагато спроб. Спробуйте за ${LOCK_MINUTES} хвилин.`;
    } else if (list[email] && await sameText(list[email], pass)) {
      if (env.TEAM_KV) await env.TEAM_KV.delete(lockKey);
      const token = await signSession(env, email);
      return new Response(null, { status: 302, headers: { Location: '/team/', 'Set-Cookie': cookie(token, SESSION_DAYS * 86400), 'Cache-Control': 'no-store' } });
    } else {
      if (env.TEAM_KV) await env.TEAM_KV.put(lockKey, String(fails + 1), { expirationTtl: LOCK_MINUTES * 60 });
      error = 'Невірна пошта або пароль.';
    }
  }
  return noStore(new Response(loginPage(error, email), { status: error ? 401 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
}

function cookie(value, maxAge) {
  return `team_session=${value}; Path=/team; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function hmac(env, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  let s = ''; for (const b of sig) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signSession(env, email) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const body = btoa(unescape(encodeURIComponent(JSON.stringify({ e: email, x: exp })))).replace(/=+$/, '');
  return body + '.' + await hmac(env, body);
}

async function sessionUser(request, env) {
  if (!env.SESSION_SECRET) return null;
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)team_session=([^;]+)/);
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig || !(await sameText(sig, await hmac(env, body)))) return null;
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob(body))));
    if (!data.x || data.x < Date.now() / 1000) return null;
    if (!users(env)[data.e]) return null; // людину прибрали зі списку — сесія більше не діє
    return data.e;
  } catch (e) { return null; }
}

async function sameText(a, b) {
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a)));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(b)));
  let d = 0; for (let i = 0; i < ha.length; i++) d |= ha[i] ^ hb[i];
  return d === 0;
}

function loginPage(error, email) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Вхід · Медіа Дотичне</title>
<link href="https://fonts.googleapis.com/css2?family=Raleway:wght@300;400;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0}body{font-family:Raleway,Arial,sans-serif;background:#fff;color:#000;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
form{width:100%;max-width:360px}h1{font-weight:700;font-size:28px;margin-bottom:6px}p{font-weight:300;color:#555;margin-bottom:28px;font-size:14px}
label{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#555;margin:16px 0 6px}
input{width:100%;padding:12px;border:1px solid rgba(0,0,0,.28);font:inherit;font-size:15px}
button{margin-top:24px;width:100%;padding:14px;background:#000;color:#fff;border:0;font:inherit;font-size:12px;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
.err{margin-top:16px;color:#b00020;font-size:14px}</style></head><body>
<form method="post" action="/team/login"><h1>Медіа Дотичне</h1><p>Вхід для співробітників</p>
<label for="e">Пошта</label><input id="e" name="email" type="email" autocomplete="username" required value="${esc(email)}">
<label for="p">Пароль</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Увійти</button>${error ? `<div class="err">${esc(error)}</div>` : ''}</form></body></html>`;
}

// Сховище для сторінки співпрацівників: ключ → текст (KV).
async function teamStorage(request, env, url, who) {
  if (!env.TEAM_KV) return new Response('Сховище не підключене', { status: 500 });
  const key = url.searchParams.get('key');
  const prefix = url.searchParams.get('prefix');
  const okKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 400 && !k.startsWith('lock:');

  if (request.method === 'GET' && key !== null) {
    if (!okKey(key)) return new Response('bad key', { status: 400 });
    const v = await env.TEAM_KV.get(key);
    return v === null ? new Response('not found', { status: 404 }) : new Response(v, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (request.method === 'GET' && prefix !== null) {
    const keys = [];
    let cursor;
    do {
      const page = await env.TEAM_KV.list({ prefix, cursor });
      for (const k of page.keys) if (!k.name.startsWith('lock:')) keys.push(k.name);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return Response.json({ keys });
  }
  if (request.method === 'PUT' && okKey(key)) {
    const body = await request.text();
    if (body.length > 24 * 1024 * 1024) return new Response('завеликий файл', { status: 413 });
    await env.TEAM_KV.put(key, body, { metadata: { by: who, at: new Date().toISOString() } });
    return new Response('ok');
  }
  if (request.method === 'DELETE' && okKey(key)) {
    await env.TEAM_KV.delete(key);
    return new Response('ok');
  }
  return new Response('bad request', { status: 400 });
}
