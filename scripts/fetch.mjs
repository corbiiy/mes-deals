// Récupère les flux RSS de Dealabs et met à jour deals.json.
// Lancé par GitHub Actions (voir .github/workflows/update.yml) ou à la main : node scripts/fetch.mjs
import { readFile, writeFile } from 'node:fs/promises';

const FEEDS = { hot: 'https://www.dealabs.com/rss/hot', new: 'https://www.dealabs.com/rss/nouveaux' };
const OUT = new URL('../deals.json', import.meta.url);
const MAX_DEALS = 400;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};
const attr = (xml, name) => {
  const m = xml.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decode(m[1]) : '';
};

function parse(xml) {
  return xml.split('<item>').slice(1).map((item) => {
    const link = tag(item, 'link');
    const id = link.match(/-(\d+)\/?$/)?.[1];
    if (!id) return null;
    const merchant = item.match(/<pepper:merchant[^>]*>/)?.[0] ?? '';
    const image = item.match(/<media:content[^>]*>/)?.[0] ?? '';
    const rawTitle = tag(item, 'title');
    const temp = rawTitle.match(/^(-?\d+)°\s*-\s*/);
    return {
      id,
      title: temp ? rawTitle.slice(temp[0].length) : rawTitle,
      temp: temp ? Number(temp[1]) : null,
      price: attr(merchant, 'price'),
      merchant: attr(merchant, 'name'),
      category: tag(item, 'category'),
      image: attr(image, 'url').replace('/re/150x150/qt/55/', '/re/300x300/qt/60/'),
      link,
      date: new Date(tag(item, 'pubDate')).toISOString(),
    };
  }).filter(Boolean);
}

async function fetchFeed(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, text/xml' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return parse(await res.text());
}

let previous = [];
try { previous = JSON.parse(await readFile(OUT, 'utf8')).deals ?? []; } catch { /* premier lancement */ }
const deals = new Map(previous.map((d) => [d.id, d]));

const [hot, fresh] = await Promise.all([fetchFeed(FEEDS.hot), fetchFeed(FEEDS.new)]);
if (!hot.length && !fresh.length) throw new Error('Flux vides : le format a peut-être changé.');

for (const d of fresh) {
  const old = deals.get(d.id);
  deals.set(d.id, { ...old, ...d, temp: old?.temp ?? null, hotDate: old?.hotDate ?? null });
}
for (const d of hot) {
  const old = deals.get(d.id);
  // Dans le flux "hot", pubDate = moment où le deal est devenu hot.
  // Un deal vu seulement dans "hot" n'a pas de date de publication connue.
  deals.set(d.id, { ...old, ...d, date: old?.date ?? null, hotDate: d.date });
}

const last = (d) => Math.max(Date.parse(d.date) || 0, Date.parse(d.hotDate) || 0);
const list = [...deals.values()].sort((a, b) => last(b) - last(a)).slice(0, MAX_DEALS);

const same = JSON.stringify(list) === JSON.stringify(previous);
if (!same) await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), deals: list }, null, 1) + '\n');
console.log(`${list.length} deals (${hot.length} hot, ${fresh.length} nouveaux)${same ? ' — aucun changement' : ''}`);
