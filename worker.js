// Медіа Дотичне — серверна частина сайту (Cloudflare Worker).
// 1) /article.html?id=…  → вставляє статтю з Notion прямо в HTML (для Google і прев'ю в соцмережах)
// 2) /sitemap.xml        → генерує карту сайту з усіма опублікованими статтями
// Усе інше віддається як звичайні статичні файли.
//
// Потрібні змінні середовища воркера: NOTION_TOKEN (Secret), NOTION_DB_ID (Text).

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
