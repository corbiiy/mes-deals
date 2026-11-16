// Récupère les flux RSS de Dealabs et met à jour deals.json.
// Lancé par GitHub Actions (voir .github/workflows/update.yml) ou à la main : node scripts/fetch.mjs
import { readFile, writeFile } from 'node:fs/promises';

const FEEDS = {
  hot: 'https://www.dealabs.com/rss/hot',
  new: 'https://www.dealabs.com/rss/nouveaux',
  all: 'https://www.dealabs.com/rss/top', // les + hot de tous les temps
};
const OUT = new URL('../deals.json', import.meta.url);
const MAX_RECENT = 300;      // deals récents jamais passés par les + hot
const MAX_MONTH = 80;        // anciens + hot gardés entre 7 et 31 jours
const DAY = 864e5;
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

// "Les + hot" du jour : pas de flux RSS (rss/top = classement de tous les temps),
// on lit donc les données intégrées à la page https://www.dealabs.com/top.
const unescapeHtml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function parseTop(html) {
  const out = [];
  for (const m of html.matchAll(/data-vue\d=(["'])(\{"name":"ThreadMainListItemNormalizer".*?)\1/g)) {
    let t;
    try { t = JSON.parse(unescapeHtml(m[2])).props?.thread; } catch { continue; }
    if (!t?.threadId || !t.title) continue;
    const img = t.mainImage;
    out.push({
      id: String(t.threadId),
      title: t.title,
      temp: Math.round(t.temperature),
      price: t.price ? t.price.toLocaleString('fr-FR', { maximumFractionDigits: 2 }).replace(/\s/g, '') + '€' : '',
      merchant: t.merchant?.merchantName ?? '',
      category: t.mainGroup?.threadGroupName ?? '',
      image: img ? `https://static-pepper.dealabs.com/${img.path}/${img.name}/re/300x300/qt/60/${img.name}.jpg` : '',
      link: t.type === 'Deal' && t.titleSlug ? `https://www.dealabs.com/bons-plans/${t.titleSlug}-${t.threadId}` : t.shareableLink,
      date: new Date(t.publishedAt * 1000).toISOString(),
      expired: Boolean(t.isExpired),
    });
  }
  return out;
}

async function fetchTop() {
  const res = await fetch('https://www.dealabs.com/top', { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`/top → HTTP ${res.status}`);
  const list = parseTop(await res.text());
  if (!list.length) throw new Error('/top : aucun deal trouvé, la page a peut-être changé.');
  return list;
}

let previous = [];
try { previous = JSON.parse(await readFile(OUT, 'utf8')).deals ?? []; } catch { /* premier lancement */ }
const deals = new Map(previous.map((d) => [d.id, { ...d }]));

const [hot, fresh, all] = await Promise.all([fetchFeed(FEEDS.hot), fetchFeed(FEEDS.new), fetchFeed(FEEDS.all).catch(() => null)]);
if (!hot.length && !fresh.length) throw new Error('Flux vides : le format a peut-être changé.');

for (const d of fresh) {
  const old = deals.get(d.id);
  deals.set(d.id, { ...old, ...d, temp: old?.temp ?? null, fresh: true });
}
for (const d of hot) {
  const old = deals.get(d.id);
  // Dans le flux "hot", pubDate = moment où le deal est devenu hot, pas sa date de publication.
  deals.set(d.id, { ...old, ...d, date: old?.date ?? null, hotDate: d.date });
}
if (all?.length) {
  for (const d of deals.values()) d.topAll = null;
  all.forEach((d, i) => {
    const old = deals.get(d.id);
    deals.set(d.id, { ...old, ...d, date: old?.date ?? d.date, topAll: i + 1 });
  });
}

// Les + hot du jour : si la page est illisible, on garde le classement précédent plutôt que d'échouer.
let top = null;
try { top = await fetchTop(); } catch (e) { console.warn(`Les + hot ignorés : ${e.message}`); }
if (top) {
  for (const d of deals.values()) d.top = null;
  top.forEach((d, i) => {
    const old = deals.get(d.id);
    // wasTop : sert à reconstituer les classements Semaine et Mois côté page.
    deals.set(d.id, { ...old, ...d, top: i + 1, wasTop: true });
  });
}

// Tri de ce qu'on garde.
const now = Date.now();
const age = (d) => now - (Date.parse(d.date) || 0);
const last = (d) => Math.max(Date.parse(d.date) || 0, Date.parse(d.hotDate) || 0);
const everything = [...deals.values()];
const ranked = everything.filter((d) => d.top || d.topAll);
const pastTop = everything.filter((d) => !d.top && !d.topAll && d.wasTop);
const week = pastTop.filter((d) => age(d) <= 7 * DAY);
const month = pastTop.filter((d) => age(d) > 7 * DAY && age(d) <= 31 * DAY)
  .sort((a, b) => b.temp - a.temp).slice(0, MAX_MONTH);
const recent = everything.filter((d) => !d.top && !d.topAll && !d.wasTop)
  .sort((a, b) => last(b) - last(a)).slice(0, MAX_RECENT);

const FIELDS = ['id', 'title', 'temp', 'price', 'merchant', 'category', 'image', 'link', 'date', 'hotDate', 'expired', 'fresh', 'top', 'topAll', 'wasTop'];
const list = [...ranked, ...week, ...month, ...recent]
  .sort((a, b) => Number(b.id) - Number(a.id))
  .map((d) => Object.fromEntries(FIELDS.filter((k) => d[k] != null && d[k] !== false && d[k] !== '').map((k) => [k, d[k]])));

const same = JSON.stringify(list) === JSON.stringify(previous);
if (!same) await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), deals: list }, null, 1) + '\n');
console.log(`${list.length} deals (${top?.length ?? 'échec'} + hot du jour, ${all?.length ?? 'échec'} + hot de tous les temps, ${hot.length} tendance, ${fresh.length} nouveaux)${same ? ' — aucun changement' : ''}`);
