// Radar · recolector de noticias
// Corre en GitHub Actions cada 3 horas. Lee los RSS de fuentes.json, traduce y resume
// con Groq lo que llega en inglés, arma el "Resumen del día" y las efemérides,
// y escribe data/noticias.json que consumen la PWA y el APK.
//
// Variables de entorno:
//   GROQ_API_KEY          clave de Groq (secreto del repositorio)
//   GROQ_MODEL            modelo principal  (por defecto openai/gpt-oss-120b)
//   GROQ_MODEL_RESPALDO   modelo de respaldo (por defecto openai/gpt-oss-20b)
//   SITE_URL              URL pública del sitio, para reutilizar traducciones previas
//   SALIDA                ruta del JSON (por defecto data/noticias.json)
//   MAX_TRADUCIR          tope de notas nuevas a traducir por corrida (por defecto 60)
//   GROQ_BASE_URL         endpoint compatible OpenAI (opcional)
//   FIXTURES              carpeta con XML locales (solo para pruebas sin red)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const AQUI = dirname(fileURLToPath(import.meta.url));
const ENV = process.env;
const GROQ_KEY = (ENV.GROQ_API_KEY || '').trim();
const MODELOS = [ENV.GROQ_MODEL || 'openai/gpt-oss-120b', ENV.GROQ_MODEL_RESPALDO || 'openai/gpt-oss-20b'];
const SALIDA = ENV.SALIDA || 'data/noticias.json';
const MAX_TRADUCIR = Number(ENV.MAX_TRADUCIR || 60);
const LOTE = 8;
const GROQ_URL = (ENV.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '') + '/chat/completions';
const UA = 'Mozilla/5.0 (compatible; RadarNoticias/1.0; +https://github.com)';
const ZONA = 'America/Lima';
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

const avisos = [];
const log = (...a) => console.log('[radar]', ...a);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- utilidades de texto ----------
const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '-', ndash: '-',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', aacute: 'á', eacute: 'é', iacute: 'í',
  oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
  uuml: 'ü', iexcl: '¡', iquest: '¿', copy: '©', reg: '®', deg: '°', middot: '·' };

function decodificar(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n in ENTIDADES ? ENTIDADES[n] : m));
}
function safeChar(n) { try { return String.fromCodePoint(n); } catch { return ''; } }

function textoPlano(v) {
  if (v == null) return '';
  if (typeof v === 'object') v = v['#text'] ?? v['__cdata'] ?? '';
  let s = String(v);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, ' ').replace(/<\/p>/gi, ' ').replace(/<[^>]+>/g, ' ');
  s = decodificar(decodificar(s));
  s = s.replace(/The post .* appeared first on .*$/i, '').replace(/La entrada .* se publicó primero en .*$/i, '');
  return s.replace(/\s+/g, ' ').trim();
}

function recortar(s, max) {
  if (!s || s.length <= max) return s || '';
  const corte = s.slice(0, max);
  const punto = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('? '), corte.lastIndexOf('! '));
  if (punto > max * 0.5) return corte.slice(0, punto + 1);
  return corte.slice(0, corte.lastIndexOf(' ')) + '…';
}

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const normUrl = (u) => { try { const x = new URL(u); [...x.searchParams.keys()].filter((k) => /^utm_|^fbclid|^ref$/.test(k)).forEach((k) => x.searchParams.delete(k)); x.hash = ''; return x.toString(); } catch { return u; } };
const normTitulo = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

function fechaLima(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// ---------- red ----------
async function traer(url, { timeout = 20000, json = false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return json ? await r.json() : await r.text();
  } finally { clearTimeout(t); }
}

// ---------- RSS / Atom ----------
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
  cdataPropName: '__cdata', processEntities: true, htmlEntities: true, trimValues: true });

function imagenDe(it, htmlCrudo) {
  const cands = [];
  for (const m of arr(it['media:content'])) if (m?.['@_url'] && (!m['@_medium'] || m['@_medium'] === 'image') && !/\.(mp4|mp3|webm)(\?|$)/i.test(m['@_url'])) cands.push(m['@_url']);
  for (const g of arr(it['media:group'])) for (const m of arr(g?.['media:content'])) if (m?.['@_url']) cands.push(m['@_url']);
  for (const m of arr(it['media:thumbnail'])) if (m?.['@_url']) cands.push(m['@_url']);
  for (const e of arr(it.enclosure)) if (e?.['@_url'] && /^image\//.test(e['@_type'] || 'image/')) cands.push(e['@_url']);
  if (it['image']?.url) cands.push(it.image.url);
  const img = /<img[^>]+src=["']([^"']+)["']/i.exec(htmlCrudo || '');
  if (img) cands.push(img[1]);
  const buena = cands.map((u) => decodificar(u)).find((u) => /^https?:\/\//.test(u) && !/feedburner|pixel|tracking|1x1|gravatar/i.test(u));
  return buena || null;
}

function crudo(v) { if (v == null) return ''; if (typeof v === 'object') return String(v['__cdata'] ?? v['#text'] ?? ''); return String(v); }

function enlaceAtom(link) {
  const ls = arr(link);
  const alt = ls.find((l) => (l?.['@_rel'] || 'alternate') === 'alternate' && l?.['@_href']) || ls.find((l) => l?.['@_href']);
  return alt ? alt['@_href'] : (typeof link === 'string' ? link : '');
}

function parsearFeed(xml, fuente) {
  const doc = parser.parse(xml);
  const salida = [];
  const rssItems = doc?.rss?.channel?.item ?? doc?.['rdf:RDF']?.item;
  const atomItems = doc?.feed?.entry;
  for (const it of arr(rssItems)) {
    const html = crudo(it['content:encoded']) || crudo(it.description);
    salida.push({
      titulo: textoPlano(it.title),
      url: textoPlano(it.link) || (typeof it.guid === 'string' ? it.guid : crudo(it.guid)),
      texto: textoPlano(it.description) || textoPlano(it['content:encoded']),
      fechaRaw: crudo(it.pubDate) || crudo(it['dc:date']) || crudo(it.published),
      imagen: imagenDe(it, html),
    });
  }
  for (const it of arr(atomItems)) {
    const html = crudo(it.content) || crudo(it.summary);
    salida.push({
      titulo: textoPlano(it.title),
      url: enlaceAtom(it.link),
      texto: textoPlano(it.summary) || textoPlano(it.content),
      fechaRaw: crudo(it.published) || crudo(it.updated),
      imagen: imagenDe(it, html),
    });
  }
  const ahora = Date.now();
  return salida
    .filter((n) => n.titulo && /^https?:\/\//.test(n.url))
    .map((n) => {
      let f = Date.parse(n.fechaRaw);
      if (Number.isNaN(f) || f > ahora + 3600e3) f = ahora;
      const url = normUrl(n.url.trim());
      return { id: hash(url), titulo: n.titulo, texto: recortar(n.texto, 900), url, imagen: n.imagen,
        fecha: new Date(f).toISOString(), fuente: fuente.nombre, categoria: fuente.categoria, idioma: fuente.idioma };
    })
    .filter((n) => ahora - Date.parse(n.fecha) <= (fuente.dias || 4) * 86400e3)
    .sort((a, b) => b.fecha.localeCompare(a.fecha))
    .slice(0, fuente.max || 8);
}

async function leerFuente(f) {
  if (ENV.FIXTURES) {
    const p = join(ENV.FIXTURES, hash(f.url) + '.xml');
    if (!existsSync(p)) throw new Error('sin fixture');
    return readFile(p, 'utf8');
  }
  return traer(f.url);
}

// ---------- Groq ----------
let modeloAgotado = new Set();

async function groq(system, user, { maxTokens = 4000 } = {}) {
  if (!GROQ_KEY) return null;
  for (const modelo of MODELOS) {
    if (modeloAgotado.has(modelo)) continue;
    let extras = modelo.includes('gpt-oss') ? { reasoning_effort: 'low' } : {};
    let formatoJson = true;
    for (let intento = 0; intento < 4; intento++) {
      const body = { model: modelo, max_completion_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...extras };
      if (formatoJson) body.response_format = { type: 'json_object' };
      let r;
      try {
        r = await fetch(GROQ_URL, { method: 'POST',
          headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } catch (e) { log('Groq red:', e.message); await dormir(3000); continue; }
      if (r.ok) {
        const data = await r.json();
        const txt = data?.choices?.[0]?.message?.content || '';
        const json = extraerJson(txt);
        if (json) return json;
        log('Groq devolvió texto no JSON, reintento');
        continue;
      }
      const err = await r.text();
      if (r.status === 429) {
        if (/per day|TPD|RPD/i.test(err)) { log(`Límite diario agotado en ${modelo}`); modeloAgotado.add(modelo); break; }
        const espera = Math.min(60, Number(r.headers.get('retry-after')) || 15 * (intento + 1));
        log(`Groq 429 en ${modelo}, espero ${espera}s`);
        await dormir(espera * 1000);
        continue;
      }
      if (r.status === 400 && /reasoning_effort/i.test(err)) { extras = {}; continue; }
      if (r.status === 400 && /response_format|json/i.test(err)) { formatoJson = false; continue; }
      if (r.status === 401) { avisos.push('La clave GROQ_API_KEY no es válida: revisa el secreto del repositorio.'); return null; }
      if (r.status === 404 || /model/i.test(err) && r.status === 400) { log(`Modelo ${modelo} no disponible: ${err.slice(0, 200)}`); break; }
      log(`Groq ${r.status}: ${err.slice(0, 300)}`);
      await dormir(4000);
    }
  }
  return null;
}

function extraerJson(txt) {
  try { return JSON.parse(txt); } catch {}
  const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(txt.slice(a, b + 1)); } catch {} }
  return null;
}

const SYS_TRADUCIR = `Eres editor de una app de noticias de ciencia, tecnología e historia para lectores de Perú.
Recibes un JSON con notas en inglés. Para cada nota:
- "titulo": tradúcelo al español latinoamericano neutro, natural y claro (no literal). Sin comillas tipográficas extra ni clickbait.
- "resumen": 2 o 3 oraciones en español (máximo 320 caracteres) que expliquen qué pasó y por qué importa, usando SOLO la información del texto. No inventes datos, cifras ni nombres.
Conserva nombres propios, marcas y siglas (NASA, IA = inteligencia artificial, etc.). Si el texto está vacío, resume a partir del título.
Responde SOLO con JSON: {"items":[{"id":"...","titulo":"...","resumen":"..."}]} con los mismos id recibidos.`;

async function traducirLote(lote) {
  const entrada = JSON.stringify({ items: lote.map((n) => ({ id: n.id, titulo: n.titulo, texto: recortar(n.texto, 700) })) });
  const res = await groq(SYS_TRADUCIR, entrada);
  const mapa = new Map();
  for (const x of arr(res?.items)) if (x?.id && x.titulo) mapa.set(String(x.id), x);
  return mapa;
}

// ---------- resumen del día ----------
async function resumenDelDia(items, hoy) {
  const desde = Date.now() - 30 * 3600e3;
  let cands = items.filter((n) => Date.parse(n.fecha) >= desde);
  if (cands.length < 10) cands = items.slice(0, 40);
  cands = cands.slice(0, 70);
  const sys = `Eres el editor jefe de una app de noticias de ciencia y tecnología en español.
De la lista, elige las 5 noticias más relevantes del día: impacto real, novedad y variedad de categorías (no repitas el mismo tema).
Para cada una escribe "porque": una frase en español (máximo 140 caracteres) de por qué importa, basada solo en el título.
Responde SOLO JSON: {"items":[{"id":"...","porque":"..."}]}`;
  const res = await groq(sys, JSON.stringify(cands.map((n) => ({ id: n.id, categoria: n.categoria, titulo: n.titulo }))), { maxTokens: 2000 });
  const ids = new Set(items.map((n) => n.id));
  let elegidos = arr(res?.items).filter((x) => ids.has(String(x?.id))).slice(0, 5).map((x) => ({ id: String(x.id), porque: String(x.porque || '').slice(0, 180) }));
  if (elegidos.length < 3) {
    // respaldo sin IA: la más reciente de cada categoría
    const vistos = new Set(); elegidos = [];
    for (const n of cands) if (!vistos.has(n.categoria)) { vistos.add(n.categoria); elegidos.push({ id: n.id, porque: '' }); }
    for (const n of cands) if (elegidos.length < 5 && !elegidos.some((e) => e.id === n.id)) elegidos.push({ id: n.id, porque: '' });
    elegidos = elegidos.slice(0, 5);
  }
  return { fecha: hoy, items: elegidos };
}

// ---------- efemérides ----------
function limpiarWiki(t) {
  let s = t.replace(/<!--[\s\S]*?-->/g, '').replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  for (let i = 0; i < 4; i++) s = s.replace(/\{\{[^{}]*\}\}/g, '');
  s = s.replace(/\[\[(?:Archivo|File|Imagen|Image):[^\]]*\]\]/gi, '');
  s = s.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[([^\]]*)\]\]/g, '$1');
  s = s.replace(/\[https?:\/\/\S+\s([^\]]*)\]/g, '$1').replace(/'{2,}/g, '').replace(/<[^>]+>/g, '');
  s = decodificar(s).replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').replace(/^[:\-–—\s]+/, '').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parsearAcontecimientos(wikitext) {
  const m = /==\s*Acontecimientos\s*==([\s\S]*?)(?:\n==[^=]|$)/.exec(wikitext);
  if (!m) return [];
  const out = []; let anioActual = null;
  for (const linea of m[1].split('\n')) {
    const y = /^\*(?!\*)\s*\[\[(?:[^\]|]*\|)?([^\]]+)\]\]\s*(?:[:\-–—]\s*)?(.*)$/.exec(linea);
    if (y && /\d/.test(y[1])) {
      anioActual = y[1].trim();
      const texto = limpiarWiki(y[2]);
      if (texto.length > 15) out.push({ anio: anioActual, texto });
    } else if (/^\*\*/.test(linea) && anioActual) {
      const texto = limpiarWiki(linea.replace(/^\*+\s*/, ''));
      if (texto.length > 15) out.push({ anio: anioActual, texto });
    }
  }
  return out;
}

const CLAVES_CIENCIA = /cient|descubr|invent|patent|lanz|sat[eé]lit|nave|espacial|cohete|astron|planeta|luna|telesc|vacuna|medic|qu[ií]mic|f[ií]sic|matem|teor[ií]a|computad|ordenador|internet|tel[eé]fon|radio|televis|el[eé]ctric|avi[oó]n|vuelo|ferrocarril|tren|motor|m[aá]quina|naturalista|evoluci|darwin|nobel|expedici|explorador|arqueol|f[oó]sil|universidad|publica|tecnolog|software|robot|n[uú]clear|[aá]tomo|genoma|adn|microscop/i;

async function efemerides(hoy) {
  const [, mes, dia] = hoy.split('-').map(Number);
  const pagina = `${dia}_de_${MESES[mes - 1]}`;
  let eventos = [];
  let fuenteUrl = `https://es.wikipedia.org/wiki/${encodeURIComponent(pagina)}`;
  try {
    const data = await traer(`https://es.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(pagina)}&prop=wikitext&format=json&formatversion=2&origin=*`, { json: true });
    eventos = parsearAcontecimientos(data?.parse?.wikitext || '');
    log(`Efemérides es.wikipedia: ${eventos.length} acontecimientos`);
  } catch (e) { log('Efemérides es.wikipedia falló:', e.message); }

  let enIngles = false;
  if (!eventos.length) {
    try {
      const mm = String(mes).padStart(2, '0'), dd = String(dia).padStart(2, '0');
      const data = await traer(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`, { json: true });
      eventos = arr(data?.events).map((e) => ({ anio: String(e.year), texto: e.text }));
      enIngles = true;
      fuenteUrl = `https://en.wikipedia.org/wiki/${MESES_EN[mes - 1]}_${dia}`;
      log(`Efemérides en.wikipedia: ${eventos.length}`);
    } catch (e) { log('Efemérides en.wikipedia falló:', e.message); }
  }
  if (!eventos.length) return { fecha: hoy, fuente: fuenteUrl, items: [] };

  const sys = `Recibes acontecimientos históricos ocurridos un ${dia} de ${MESES[mes - 1]}${enIngles ? ' (en inglés)' : ''}.
Elige hasta 6, priorizando ciencia, tecnología, inventos, exploración espacial, medicina y descubrimientos; completa con hechos históricos muy relevantes si faltan.
Reescribe cada uno en español, en una sola oración clara de máximo 180 caracteres, usando SOLO la información dada. No agregues datos.
Ordénalos por año ascendente. Responde SOLO JSON: {"items":[{"anio":"...","texto":"..."}]}`;
  const lista = eventos.slice(0, 160).map((e) => ({ anio: e.anio, texto: recortar(e.texto, 240) }));
  const res = await groq(sys, JSON.stringify(lista), { maxTokens: 2500 });
  let items = arr(res?.items).filter((x) => x?.anio && x?.texto).slice(0, 6).map((x) => ({ anio: String(x.anio), texto: String(x.texto).slice(0, 220) }));
  if (!items.length && !enIngles) {
    const puntuados = eventos.filter((e) => CLAVES_CIENCIA.test(e.texto));
    items = (puntuados.length >= 3 ? puntuados : eventos).slice(-6).map((e) => ({ anio: e.anio, texto: recortar(e.texto, 220) }));
  }
  return { fecha: hoy, fuente: fuenteUrl, items };
}
const MESES_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ---------- datos previos (caché de traducciones) ----------
async function datosPrevios() {
  if (ENV.SITE_URL && !ENV.FIXTURES) {
    try {
      const url = ENV.SITE_URL.replace(/\/?$/, '/') + 'data/noticias.json?nocache=' + Date.now();
      const d = await traer(url, { json: true });
      log(`Datos previos: ${d?.items?.length || 0} notas desde el sitio`);
      return d;
    } catch (e) { log('Sin datos previos del sitio:', e.message); }
  }
  if (existsSync(SALIDA)) { try { return JSON.parse(await readFile(SALIDA, 'utf8')); } catch {} }
  return null;
}

// ---------- principal ----------
async function main() {
  const hoy = fechaLima();
  const { fuentes } = JSON.parse(await readFile(join(AQUI, 'fuentes.json'), 'utf8'));
  const previo = await datosPrevios();
  const cache = new Map(arr(previo?.items).filter((n) => n.traducido).map((n) => [n.id, n]));
  if (!GROQ_KEY) avisos.push('Falta el secreto GROQ_API_KEY: solo se muestran fuentes en español.');

  // 1. Descargar feeds en paralelo
  const estados = [];
  const resultados = await Promise.allSettled(fuentes.map(async (f) => parsearFeed(await leerFuente(f), f)));
  let todas = [];
  resultados.forEach((r, i) => {
    const f = fuentes[i];
    if (r.status === 'fulfilled') { todas.push(...r.value); estados.push({ nombre: f.nombre, categoria: f.categoria, idioma: f.idioma, ok: true, n: r.value.length }); }
    else { estados.push({ nombre: f.nombre, categoria: f.categoria, idioma: f.idioma, ok: false, n: 0, error: String(r.reason?.message || r.reason).slice(0, 120) }); log(`✗ ${f.nombre}: ${r.reason?.message}`); }
  });
  log(`Feeds OK: ${estados.filter((e) => e.ok).length}/${fuentes.length} · notas: ${todas.length}`);

  // 2. Deduplicar
  const vistosUrl = new Set(), vistosTit = new Set();
  todas = todas.sort((a, b) => b.fecha.localeCompare(a.fecha)).filter((n) => {
    const t = normTitulo(n.titulo).slice(0, 80);
    if (vistosUrl.has(n.id) || vistosTit.has(t)) return false;
    vistosUrl.add(n.id); vistosTit.add(t); return true;
  });

  // 3. Español: limpiar. Inglés: reutilizar caché o traducir.
  const listas = [], pendientes = [];
  for (const n of todas) {
    if (n.idioma === 'es') { listas.push({ ...n, resumen: recortar(n.texto, 320), traducido: false }); continue; }
    const c = cache.get(n.id);
    if (c) { listas.push({ ...n, tituloOriginal: n.titulo, titulo: c.titulo, resumen: c.resumen, traducido: true }); continue; }
    pendientes.push(n);
  }
  const aTraducir = pendientes.slice(0, GROQ_KEY ? MAX_TRADUCIR : 0);
  log(`Reutilizadas: ${cache.size ? listas.filter((n) => n.traducido).length : 0} · por traducir: ${aTraducir.length} (pendientes totales ${pendientes.length})`);
  let traducidas = 0;
  for (let i = 0; i < aTraducir.length; i += LOTE) {
    const lote = aTraducir.slice(i, i + LOTE);
    const mapa = await traducirLote(lote);
    for (const n of lote) {
      const t = mapa.get(n.id);
      if (t) { listas.push({ ...n, tituloOriginal: n.titulo, titulo: String(t.titulo).trim(), resumen: recortar(String(t.resumen || '').trim(), 360), traducido: true }); traducidas++; }
    }
    if (i + LOTE < aTraducir.length) await dormir(2500);
  }
  const sinTraducir = pendientes.length - traducidas;
  if (GROQ_KEY && sinTraducir > 0) log(`${sinTraducir} notas en inglés quedan para la próxima corrida`);

  const items = listas
    .map(({ texto, idioma, ...resto }) => ({ ...resto, idiomaOriginal: idioma }))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));

  // 4. Resumen del día y efemérides
  const resumen = items.length ? await resumenDelDia(items, hoy) : { fecha: hoy, items: [] };
  let efem = previo?.efemerides;
  if (!(efem?.fecha === hoy && efem.items?.length)) efem = await efemerides(hoy);

  const salida = {
    version: 1,
    generado: new Date().toISOString(),
    fecha: hoy,
    zona: ZONA,
    modelo: GROQ_KEY ? MODELOS.find((m) => !modeloAgotado.has(m)) || MODELOS[0] : null,
    avisos,
    totales: { notas: items.length, traducidas: items.filter((n) => n.traducido).length, pendientes: Math.max(0, sinTraducir) },
    resumenDia: resumen,
    efemerides: efem,
    fuentes: estados,
    items,
  };
  await mkdir(dirname(SALIDA), { recursive: true });
  await writeFile(SALIDA, JSON.stringify(salida));
  log(`Escrito ${SALIDA}: ${items.length} notas (${salida.totales.traducidas} traducidas), efemérides ${efem?.items?.length || 0}, resumen ${resumen.items.length}`);
}

export { parsearFeed, parsearAcontecimientos, limpiarWiki, textoPlano, hash };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
