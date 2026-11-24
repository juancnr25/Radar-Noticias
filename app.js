/* Radar · PWA de noticias de ciencia, tecnología e historia (vanilla JS, offline-first) */
(() => {
  'use strict';

  const CONFIG = window.RADAR_CONFIG || {};
  const DATA_URL = CONFIG.dataUrl || 'data/noticias.json';
  const NATIVO = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const CATEGORIAS = { tecnologia: 'Tecnología', hallazgos: 'Hallazgos', ciencia: 'Ciencia', historia: 'Historia' };
  const REFRESCO_AUTO_MS = 30 * 60 * 1000;
  const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const MODELOS = [
    ['openai/gpt-oss-120b', 'GPT-OSS 120B (mejor calidad)'],
    ['openai/gpt-oss-20b', 'GPT-OSS 20B (más rápido)'],
    ['qwen/qwen3-32b', 'Qwen3 32B'],
  ];
  const MAX_ARTICULOS = 80;
  const TIPOS_TEXTO = new Set(['p', 'h', 'li', 'q', 'cap']);

  // ---------- repositorio IndexedDB ----------
  const Repo = (() => {
    let dbp;
    const abrir = () => dbp || (dbp = new Promise((ok, mal) => {
      const r = indexedDB.open('radar', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('guardados')) db.createObjectStore('guardados', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('articulos')) db.createObjectStore('articulos', { keyPath: 'id' });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => mal(r.error);
    }));
    const tx = async (store, modo, fn) => {
      const db = await abrir();
      return new Promise((ok, mal) => {
        const t = db.transaction(store, modo);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => ok(req && req.result);
        t.onerror = () => mal(t.error);
      });
    };
    return {
      get: (k) => tx('kv', 'readonly', (s) => s.get(k)).catch(() => undefined),
      set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)).catch(() => {}),
      guardados: () => tx('guardados', 'readonly', (s) => s.getAll()).catch(() => []),
      guardar: (n) => tx('guardados', 'readwrite', (s) => s.put({ ...n, guardadoEn: Date.now() })),
      quitar: (id) => tx('guardados', 'readwrite', (s) => s.delete(id)),
      articulo: (id) => tx('articulos', 'readonly', (s) => s.get(id)).catch(() => undefined),
      guardarArticulo: (a) => tx('articulos', 'readwrite', (s) => s.put({ ...a, usado: Date.now() })).catch(() => {}),
      articulos: () => tx('articulos', 'readonly', (s) => s.getAll()).catch(() => []),
      borrarArticulo: (id) => tx('articulos', 'readwrite', (s) => s.delete(id)).catch(() => {}),
    };
  })();

  // ---------- estado ----------
  const estado = {
    datos: null,
    desdeCache: false,
    vista: 'hoy',
    guardados: new Map(),
    ajustes: { vibrar: true, escala: 1, groqKey: '', modelo: 'openai/gpt-oss-120b', autoTraducir: true, proxy: '' },
    ultimaVisita: 0,
    ultimaDescarga: 0,
    cargando: false,
  };
  const lector = { nota: null, art: null, modo: 'es', estado: '', error: null };
  const enCurso = new Map(); // id -> promesa de carga/traducción

  // ---------- utilidades ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const urlSegura = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  function haceCuanto(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const min = Math.round((Date.now() - t) / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return `hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.round(h / 24);
    if (d === 1) return 'ayer';
    if (d < 7) return `hace ${d} días`;
    return new Date(t).toLocaleDateString('es-PE', { day: 'numeric', month: 'short' });
  }
  const horaCorta = (iso) => new Date(iso).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false });
  function fechaLarga(ymd) {
    const [y, m, d] = (ymd || '').split('-').map(Number);
    if (!y) return '';
    return new Date(y, m - 1, d).toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function tic(ms = 8) {
    if (estado.ajustes.vibrar && navigator.vibrate) { try { navigator.vibrate(ms); } catch {} }
  }

  let toastT;
  function toast(msg, accion) {
    const el = $('#toast');
    el.innerHTML = esc(msg);
    el.onclick = accion || null;
    el.classList.add('visible');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove('visible'), accion ? 7000 : 2600);
  }

  const porId = () => new Map((estado.datos?.items || []).map((n) => [n.id, n]));
  const buscarNota = (id) => porId().get(id) || estado.guardados.get(id);
  const esIngles = (n) => n && (n.idiomaOriginal === 'en' || n.traducido);

  // ---------- datos ----------
  async function descargar({ silencioso = false } = {}) {
    if (estado.cargando) return;
    estado.cargando = true;
    $('#btnRefrescar').classList.add('girando');
    try {
      const sep = DATA_URL.includes('?') ? '&' : '?';
      const r = await fetch(`${DATA_URL}${sep}t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const datos = await r.json();
      if (!datos || !Array.isArray(datos.items)) throw new Error('Formato inválido');
      const antes = estado.datos?.generado;
      estado.datos = datos;
      estado.desdeCache = false;
      estado.ultimaDescarga = Date.now();
      await Repo.set('datos', datos);
      render();
      if (!silencioso) toast(antes && antes === datos.generado ? 'Ya tienes lo más reciente' : `${datos.items.length} noticias actualizadas`);
    } catch (e) {
      estado.desdeCache = !!estado.datos;
      render();
      if (!silencioso || !estado.datos) toast(estado.datos ? 'Sin conexión: mostrando lo último guardado' : 'No se pudieron cargar las noticias');
    } finally {
      estado.cargando = false;
      $('#btnRefrescar').classList.remove('girando');
    }
  }

  // ================= TEXTO COMPLETO =================
  async function descargarHtml(url) {
    let destino = url;
    const proxy = (estado.ajustes.proxy || '').trim();
    if (!NATIVO && proxy) destino = proxy + (proxy.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(url);
    let r;
    try {
      r = await fetch(destino, { credentials: 'omit', redirect: 'follow' });
    } catch (e) {
      const err = new Error(NATIVO ? 'Sin conexión o el sitio no respondió.' : 'cors');
      err.tipo = NATIVO ? 'red' : (proxy ? 'red' : 'cors');
      throw err;
    }
    if (!r.ok) { const err = new Error(`El sitio respondió ${r.status}.`); err.tipo = 'http'; throw err; }
    return r.text();
  }

  function aBloques(html, url) {
    const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const out = [];
    const vistas = new Set();
    const txt = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const img = (el) => {
      let s = el.getAttribute('src') || el.getAttribute('data-src') || '';
      if (!s || s.startsWith('data:')) {
        const ss = el.getAttribute('srcset') || el.getAttribute('data-srcset') || '';
        s = ss ? ss.split(',').pop().trim().split(/\s+/)[0] : '';
      }
      try { s = new URL(s, url).href; } catch { return; }
      if (!/^https?:/.test(s) || vistas.has(s) || /pixel|tracking|1x1|spacer/i.test(s)) return;
      vistas.add(s);
      out.push({ t: 'img', src: s, alt: el.getAttribute('alt') || '' });
    };
    const walk = (nodo) => {
      for (const el of nodo.children) {
        if (out.length > 300) return;
        const tag = el.tagName;
        if (/^H[1-6]$/.test(tag)) { const t = txt(el); if (t) out.push({ t: 'h', x: t }); }
        else if (tag === 'P') { el.querySelectorAll('img').forEach(img); const t = txt(el); if (t.length > 1) out.push({ t: 'p', x: t }); }
        else if (tag === 'IMG') img(el);
        else if (tag === 'PICTURE') { const i = el.querySelector('img'); if (i) img(i); }
        else if (tag === 'FIGURE') {
          el.querySelectorAll('img').forEach(img);
          const c = el.querySelector('figcaption');
          if (c && txt(c)) out.push({ t: 'cap', x: txt(c) });
        }
        else if (tag === 'UL' || tag === 'OL') { for (const li of el.querySelectorAll(':scope > li')) { const t = txt(li); if (t) out.push({ t: 'li', x: t }); } }
        else if (tag === 'BLOCKQUOTE') { const t = txt(el); if (t) out.push({ t: 'q', x: t }); }
        else if (/^(SCRIPT|STYLE|IFRAME|VIDEO|AUDIO|SVG|BUTTON|FORM|NOSCRIPT|TABLE)$/.test(tag)) continue;
        else if (!el.children.length) { const t = txt(el); if (t.length > 1) out.push({ t: 'p', x: t }); }
        else walk(el);
      }
    };
    walk(d.body.firstElementChild || d.body);
    return out;
  }

  function extraer(html, url) {
    if (typeof Readability !== 'function') throw new Error('Falta el módulo de lectura.');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const base = doc.createElement('base');
    base.href = url;
    doc.head && doc.head.prepend(base);
    doc.querySelectorAll('img').forEach((im) => {
      const s = im.getAttribute('data-src') || im.getAttribute('data-lazy-src') || im.getAttribute('data-original');
      const actual = im.getAttribute('src') || '';
      if (s && (!actual || actual.startsWith('data:'))) im.setAttribute('src', s);
    });
    const art = new Readability(doc, { charThreshold: 300 }).parse();
    const largo = (art?.textContent || '').replace(/\s+/g, ' ').trim().length;
    if (!art || largo < 300) { const e = new Error('No encontré el texto del artículo. Puede tener muro de pago o un formato especial.'); e.tipo = 'extraccion'; throw e; }
    let bloques = aBloques(art.content, url);
    // quita el titular repetido: encabezados antes del primer párrafo
    const primerP = bloques.findIndex((b) => b.t === 'p');
    bloques = bloques.filter((b, i) => !(b.t === 'h' && i < primerP));
    if (!bloques.some((b) => b.t === 'p')) { const e = new Error('El artículo no tiene párrafos legibles.'); e.tipo = 'extraccion'; throw e; }
    const palabras = bloques.filter((b) => TIPOS_TEXTO.has(b.t)).reduce((s, b) => s + b.x.split(' ').length, 0);
    return { bloques, palabras, autor: art.byline || '' };
  }

  // ---------- Groq desde el dispositivo ----------
  function extraerJson(txt) {
    try { return JSON.parse(txt); } catch {}
    const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(txt.slice(a, b + 1)); } catch {} }
    return null;
  }

  async function groq(system, user, { maxTokens = 6000 } = {}) {
    const key = (estado.ajustes.groqKey || '').trim();
    if (!key) { const e = new Error('Falta tu clave de Groq.'); e.tipo = 'sinclave'; throw e; }
    const modelos = [...new Set([estado.ajustes.modelo || MODELOS[0][0], 'openai/gpt-oss-20b'])];
    let ultimoError = 'Groq no respondió.';
    for (const modelo of modelos) {
      let extras = modelo.includes('gpt-oss') ? { reasoning_effort: 'low' } : {};
      let json = true;
      for (let intento = 0; intento < 4; intento++) {
        const body = { model: modelo, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...extras };
        if (json) body.response_format = { type: 'json_object' };
        let r;
        try {
          r = await fetch(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        } catch { ultimoError = 'Sin conexión con Groq.'; await dormir(1500); continue; }
        const texto = await r.text();
        if (r.ok) {
          const data = extraerJson(texto);
          const contenido = data?.choices?.[0]?.message?.content || '';
          const res = extraerJson(contenido);
          if (res) return { res, modelo };
          ultimoError = 'Respuesta incompleta de Groq.';
          continue;
        }
        if (r.status === 401) { const e = new Error('Tu clave de Groq no es válida.'); e.tipo = 'clave'; throw e; }
        if (r.status === 429) {
          if (/per day|TPD|RPD/i.test(texto)) { ultimoError = `Límite diario agotado en ${modelo}.`; break; }
          const espera = Math.min(30, Number(r.headers.get('retry-after')) || 6 * (intento + 1));
          lectorEstado(`Groq pide esperar ${espera} s…`);
          await dormir(espera * 1000);
          continue;
        }
        if (r.status === 400 && /reasoning_effort/i.test(texto)) { extras = {}; continue; }
        if (r.status === 400 && /json_validate_failed/i.test(texto)) { json = false; continue; }
        if (r.status === 400 && /response_format/i.test(texto)) { json = false; continue; }
        ultimoError = `Groq ${r.status}: ${texto.slice(0, 120)}`;
        if (r.status === 404 || /model/i.test(texto)) break;
      }
    }
    throw new Error(ultimoError);
  }

  const SYS_TRADUCIR = `Eres traductor profesional de divulgación científica y tecnológica para lectores de Perú.
Recibes un JSON {"t":[...]} con fragmentos de un artículo en inglés, en orden.
Traduce cada fragmento al español latinoamericano neutro, de forma fiel, completa y natural.
Reglas: el arreglo de salida tiene EXACTAMENTE la misma cantidad de elementos y el mismo orden. No resumas, no omitas, no agregues información ni comentarios. Conserva nombres propios, cifras, unidades y siglas. Si un fragmento ya está en español o es un nombre, cópialo igual.
Responde SOLO con JSON: {"t":["...", "..."]}`;

  function lotes(indices, bloques, maxChars = 3200, maxItems = 24) {
    const out = [];
    let actual = [], chars = 0;
    for (const i of indices) {
      const n = bloques[i].x.length;
      if (actual.length && (chars + n > maxChars || actual.length >= maxItems)) { out.push(actual); actual = []; chars = 0; }
      actual.push(i); chars += n;
    }
    if (actual.length) out.push(actual);
    return out;
  }

  const necesitaTraduccion = (art) => art && art.idioma === 'en' && art.bloques.some((b, i) => TIPOS_TEXTO.has(b.t) && art.tr?.[i] == null);

  async function traducir(art) {
    art.tr = art.tr || {};
    const indices = art.bloques.map((b, i) => (TIPOS_TEXTO.has(b.t) && art.tr[i] == null ? i : -1)).filter((i) => i >= 0);
    const grupos = lotes(indices, art.bloques);
    let hechos = 0;
    for (const grupo of grupos) {
      if (esLectorDe(art.id)) lectorEstado(`Traduciendo ${hechos + 1}/${grupos.length}…`);
      const textos = grupo.map((i) => art.bloques[i].x);
      const { res, modelo } = await groq(SYS_TRADUCIR, JSON.stringify({ t: textos }));
      const t = Array.isArray(res?.t) ? res.t : [];
      grupo.forEach((i, k) => { if (typeof t[k] === 'string' && t[k].trim()) art.tr[i] = t[k].trim(); });
      art.modelo = modelo;
      hechos++;
      await Repo.guardarArticulo(art);
      if (esLectorDe(art.id)) pintarTraducciones(art, grupo);
    }
    // segunda pasada para fragmentos que quedaron sin traducir (respuesta desalineada)
    const faltan = art.bloques.map((b, i) => (TIPOS_TEXTO.has(b.t) && art.tr[i] == null ? i : -1)).filter((i) => i >= 0);
    for (const grupo of lotes(faltan, art.bloques, 1200, 6)) {
      const { res } = await groq(SYS_TRADUCIR, JSON.stringify({ t: grupo.map((i) => art.bloques[i].x) }));
      grupo.forEach((i, k) => { const x = res?.t?.[k]; art.tr[i] = typeof x === 'string' && x.trim() ? x.trim() : art.bloques[i].x; });
      await Repo.guardarArticulo(art);
      if (esLectorDe(art.id)) pintarTraducciones(art, grupo);
    }
    art.traducidoEn = Date.now();
    await Repo.guardarArticulo(art);
  }

  // Descarga (o recupera) el artículo y, si toca, lo traduce. Una sola tarea por nota.
  function cargarArticulo(n, { traducirAhora = estado.ajustes.autoTraducir } = {}) {
    const clave = n.id;
    if (enCurso.has(clave)) return enCurso.get(clave);
    const p = (async () => {
      let art = await Repo.articulo(n.id);
      if (!art || !art.bloques?.length) {
        if (esLectorDe(n.id)) lectorEstado('Descargando el artículo…');
        const html = await descargarHtml(n.url);
        if (esLectorDe(n.id)) lectorEstado('Extrayendo el texto…');
        const ex = extraer(html, n.url);
        art = { id: n.id, url: n.url, idioma: esIngles(n) ? 'en' : 'es', bloques: ex.bloques, palabras: ex.palabras, autor: ex.autor, tr: {}, descargado: Date.now() };
        await Repo.guardarArticulo(art);
      }
      if (esLectorDe(n.id)) { lector.art = art; pintarLector(); }
      if (traducirAhora && necesitaTraduccion(art) && estado.ajustes.groqKey) {
        await traducir(art);
      }
      return art;
    })().finally(() => enCurso.delete(clave));
    enCurso.set(clave, p);
    return p;
  }

  async function podarArticulos() {
    const todos = await Repo.articulos();
    if (todos.length <= MAX_ARTICULOS) return;
    const libres = todos.filter((a) => !estado.guardados.has(a.id)).sort((a, b) => (a.usado || 0) - (b.usado || 0));
    for (const a of libres.slice(0, todos.length - MAX_ARTICULOS)) await Repo.borrarArticulo(a.id);
  }

  // ================= RENDER PRINCIPAL =================
  function renderEstado() {
    const d = estado.datos;
    const el = $('#estado');
    if (!d) { el.textContent = estado.cargando ? 'Sintonizando…' : 'Sin datos'; return; }
    const offline = estado.desdeCache || !navigator.onLine;
    el.textContent = `${offline ? 'OFFLINE · ' : ''}ACT ${horaCorta(d.generado)} · ${d.items.length} NOTAS`;
  }

  function renderBanner() {
    const b = $('#banner');
    const avisos = [...(estado.datos?.avisos || [])];
    if (estado.desdeCache && estado.datos) avisos.unshift(`Sin conexión. Mostrando datos de ${haceCuanto(estado.datos.generado)}.`);
    b.hidden = !avisos.length;
    b.innerHTML = avisos.map(esc).join('<br>');
  }

  function metaHtml(n) {
    return `<div class="meta"><span class="cat cat-${esc(n.categoria)}">${esc(CATEGORIAS[n.categoria] || n.categoria)}</span>` +
      `<span>${esc(n.fuente)}</span><span>${esc(haceCuanto(n.fecha))}</span>` +
      (n.traducido ? '<span class="trad" title="Traducido del inglés">EN→ES</span>' : '') + '</div>';
  }

  function tarjeta(n, destacada = false) {
    const nueva = estado.ultimaVisita && Date.parse(n.fecha) > estado.ultimaVisita;
    const img = n.imagen ? `<div class="img"><img src="${esc(urlSegura(n.imagen))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.parentNode.classList.add('sin-img');this.parentNode.remove()"></div>` : '';
    return `<article class="nota${destacada ? ' destacada' : ''}${n.imagen ? '' : ' sin-img'}" data-id="${esc(n.id)}">
      ${nueva ? '<span class="nueva" title="Nueva desde tu última visita"></span>' : ''}
      <div class="cuerpo">${destacada ? '<div style="height:12px"></div>' : ''}${metaHtml(n)}<h3>${esc(n.titulo)}</h3>${n.resumen ? `<p>${esc(n.resumen)}</p>` : ''}</div>
      ${img}</article>`;
  }

  const esqueleto = () => '<div class="lista" style="margin-top:18px">' + '<div class="esq"></div>'.repeat(5) + '</div>';
  const vacio = (icono, txt) => `<div class="vacio"><div class="grande">${icono}</div><p>${esc(txt)}</p></div>`;

  function vistaHoy() {
    const d = estado.datos;
    if (!d) return esqueleto();
    const mapa = porId();
    let html = '';
    const res = (d.resumenDia?.items || []).map((r) => ({ ...r, n: mapa.get(r.id) })).filter((r) => r.n);
    if (res.length) {
      html += `<section class="seccion"><h2 class="rotulo">Resumen del día <small>${esc(fechaLarga(d.resumenDia.fecha || d.fecha))}</small></h2><ol class="resumen">` +
        res.map((r, i) => `<li data-id="${esc(r.n.id)}"><span class="num">${String(i + 1).padStart(2, '0')}</span><div>` +
          `<h3>${esc(r.n.titulo)}</h3>${r.porque ? `<p class="porque">${esc(r.porque)}</p>` : ''}${metaHtml(r.n)}</div></li>`).join('') +
        '</ol></section>';
    }
    const ef = d.efemerides;
    if (ef?.items?.length) {
      html += `<section class="seccion"><h2 class="rotulo">Un día como hoy <small>${esc(fechaLarga(ef.fecha))}</small></h2><ul class="efem">` +
        ef.items.map((e) => `<li><span class="anio">${esc(e.anio)}</span><p>${esc(e.texto)}</p></li>`).join('') + '</ul>' +
        (ef.fuente ? `<a class="enlace-sutil" href="${esc(urlSegura(ef.fuente))}" target="_blank" rel="noopener">Ver más en Wikipedia →</a>` : '') + '</section>';
    }
    const ultimas = d.items.slice(0, 6);
    if (ultimas.length) {
      html += `<section class="seccion"><h2 class="rotulo">Recién llegadas <small>${d.items.length} en total</small></h2><div class="lista">` +
        ultimas.map((n, i) => tarjeta(n, i === 0)).join('') + '</div>' +
        '<button class="boton ver-todas" data-ir="ultimo">Ver todas las noticias →</button></section>';
    }
    return html || vacio('📡', 'Aún no hay noticias. Ejecuta el workflow "Actualizar noticias" en GitHub.');
  }

  function vistaLista(cat) {
    const d = estado.datos;
    if (!d) return esqueleto();
    const items = cat ? d.items.filter((n) => n.categoria === cat) : d.items;
    const nombre = cat ? CATEGORIAS[cat] : 'Lo último';
    const nuevas = estado.ultimaVisita ? items.filter((n) => Date.parse(n.fecha) > estado.ultimaVisita).length : 0;
    let html = `<h2 class="titulo-vista">${esc(nombre)}</h2><p class="sub-vista mono">${items.length} notas${nuevas ? ` · ${nuevas} nuevas` : ''}</p>`;
    if (!items.length) return html + vacio('🛰️', 'No hay notas en esta sección por ahora.');
    return html + '<div class="lista">' + items.map((n, i) => tarjeta(n, i === 0)).join('') + '</div>';
  }

  function vistaGuardados() {
    const items = [...estado.guardados.values()].sort((a, b) => (b.guardadoEn || 0) - (a.guardadoEn || 0));
    let html = `<h2 class="titulo-vista">Guardados</h2><p class="sub-vista mono">${items.length} notas · texto completo sin conexión</p>`;
    if (!items.length) return html + vacio('☆', 'Abre una noticia y toca el marcador para guardarla con su texto completo y leerla sin internet.');
    return html + '<div class="lista">' + items.map((n) => tarjeta(n)).join('') + '</div>';
  }

  function render() {
    renderEstado();
    renderBanner();
    const v = estado.vista;
    $('#vista').innerHTML = v === 'hoy' ? vistaHoy() : v === 'guardados' ? vistaGuardados() : vistaLista(v === 'ultimo' ? null : v);
    $('#numGuardados').textContent = estado.guardados.size || '';
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('activa', b.dataset.vista === v));
  }

  function irA(vista) {
    estado.vista = vista;
    render();
    window.scrollTo({ top: 0 });
    const tab = document.querySelector(`#tabs button[data-vista="${vista}"]`);
    tab && tab.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    Repo.set('vista', vista);
  }

  // ================= CAPAS (lector y hoja) con botón atrás =================
  const capas = [];
  let ignorarPop = false;
  function abrirCapa(nombre) {
    $('#' + nombre).hidden = false;
    document.body.style.overflow = 'hidden';
    if (!capas.includes(nombre)) { capas.push(nombre); history.pushState({ capa: nombre }, ''); }
  }
  function ocultarCapa(nombre) {
    $('#' + nombre).hidden = true;
    const i = capas.indexOf(nombre);
    if (i >= 0) capas.splice(i, 1);
    if (!capas.length) document.body.style.overflow = '';
    if (nombre === 'hoja') alCerrarHoja();
    if (nombre === 'lector') { lector.nota = null; lector.art = null; }
  }
  function cerrarCapa(nombre = capas[capas.length - 1]) {
    if (!nombre || !capas.includes(nombre)) return;
    ocultarCapa(nombre);
    ignorarPop = true;
    history.back();
  }
  window.addEventListener('popstate', () => {
    if (ignorarPop) { ignorarPop = false; return; }
    const top = capas[capas.length - 1];
    if (top) ocultarCapa(top);
  });

  // ================= LECTOR =================
  const esLectorDe = (id) => lector.nota && lector.nota.id === id && !$('#lector').hidden;
  function lectorEstado(txt) { lector.estado = txt; const el = $('#lectorEstado'); if (el) el.textContent = txt; }

  const ICONO_GUARDAR = (lleno) => `<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z" fill="${lleno ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;

  function abrirLector(id) {
    const n = buscarNota(id);
    if (!n) return;
    lector.nota = n; lector.art = null; lector.error = null; lector.modo = 'es'; lector.estado = '';
    abrirCapa('lector');
    $('#lector').scrollTop = 0;
    cargarEnLector();
  }

  function cargarEnLector() {
    const n = lector.nota;
    if (!n) return;
    lector.error = null;
    pintarLector();
    cargarArticulo(n)
      .then((art) => { if (esLectorDe(n.id)) { lector.art = art; pintarLector(); } })
      .catch((e) => {
        if (!esLectorDe(n.id)) return;
        if (lector.art) toast(e.message); else lector.error = e;
        pintarLector();
      });
  }

  function textoBloque(art, b, i) {
    if (lector.modo === 'es' && art.idioma === 'en') return art.tr?.[i] ?? b.x;
    return b.x;
  }

  function htmlBloque(art, b, i) {
    if (b.t === 'img') return `<figure class="lec-fig"><img src="${esc(urlSegura(b.src))}" alt="${esc(b.alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></figure>`;
    const pendiente = lector.modo === 'es' && art.idioma === 'en' && art.tr?.[i] == null ? ' pendiente' : '';
    const t = esc(textoBloque(art, b, i));
    const tag = { h: 'h2', p: 'p', li: 'li', q: 'blockquote', cap: 'figcaption' }[b.t] || 'p';
    return `<${tag} class="lec-${b.t}${pendiente}" data-i="${i}">${t}</${tag}>`;
  }

  function pintarLector() {
    const n = lector.nota;
    if (!n) return;
    const art = lector.art;
    const guardada = estado.guardados.has(n.id);
    const ingles = art ? art.idioma === 'en' : esIngles(n);
    const completo = art && !necesitaTraduccion(art);
    let estadoTxt = lector.estado;
    if (art && !enCurso.has(n.id)) {
      estadoTxt = ingles
        ? (lector.modo === 'en' ? 'Original en inglés' : completo ? `Traducido · ${art.palabras} palabras` : 'Traducción pendiente')
        : `${art.palabras} palabras · ${Math.max(1, Math.round(art.palabras / 220))} min`;
    }
    if (lector.error) estadoTxt = 'Sin texto completo';

    let cuerpo = '';
    if (art) {
      let lista = false;
      for (let i = 0; i < art.bloques.length; i++) {
        const b = art.bloques[i];
        if (b.t === 'li' && !lista) { cuerpo += '<ul class="lec-ul">'; lista = true; }
        if (b.t !== 'li' && lista) { cuerpo += '</ul>'; lista = false; }
        cuerpo += htmlBloque(art, b, i);
      }
      if (lista) cuerpo += '</ul>';
      if (ingles && necesitaTraduccion(art) && !estado.ajustes.groqKey) {
        cuerpo = avisoClave() + cuerpo;
      } else if (ingles && necesitaTraduccion(art) && !enCurso.has(n.id) && lector.modo === 'es') {
        cuerpo = `<div class="lec-aviso"><p>Una parte del texto sigue en inglés.</p><button class="boton primario" data-lector="traducir">Traducir ahora</button></div>` + cuerpo;
      }
    } else if (lector.error) {
      cuerpo = avisoError(lector.error) + resumenPrevio(n);
    } else {
      cuerpo = resumenPrevio(n) + '<div class="lec-cargando"><div class="esq-linea"></div><div class="esq-linea"></div><div class="esq-linea corta"></div></div>';
    }

    $('#lector').innerHTML = `
      <header class="lec-barra">
        <button class="icono" data-lector="cerrar" aria-label="Volver"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <span id="lectorEstado" class="lec-estado mono">${esc(estadoTxt)}</span>
        ${ingles && art ? `<button class="chip-idioma mono" data-lector="idioma" aria-label="Cambiar idioma">${lector.modo === 'es' ? 'ES' : 'EN'}</button>` : ''}
        <button class="icono${guardada ? ' activo' : ''}" data-guardar="${esc(n.id)}" aria-label="${guardada ? 'Quitar de guardados' : 'Guardar'}">${ICONO_GUARDAR(guardada)}</button>
        <button class="icono" data-compartir="${esc(n.id)}" aria-label="Compartir"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </header>
      <article class="lec">
        ${n.imagen && !(art && art.bloques.slice(0, 3).some((b) => b.t === 'img')) ? `<img class="lec-hero" src="${esc(urlSegura(n.imagen))}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
        <div class="lec-texto">
          ${metaHtml(n)}
          <h1 class="lec-titulo">${esc(lector.modo === 'en' && n.tituloOriginal ? n.tituloOriginal : n.titulo)}</h1>
          ${art?.autor ? `<p class="lec-autor mono">${esc(art.autor)}</p>` : ''}
          ${cuerpo}
          <footer class="lec-pie">
            <p>Fuente: <strong>${esc(n.fuente)}</strong>${ingles ? ' · traducción automática con IA para lectura personal' : ''}.</p>
            <a class="boton" href="${esc(urlSegura(n.url))}" target="_blank" rel="noopener">Ver en ${esc(n.fuente)} ↗</a>
          </footer>
        </div>
      </article>`;
  }

  function resumenPrevio(n) {
    return n.resumen ? `<p class="lec-resumen">${esc(n.resumen)}</p>` : '';
  }

  function avisoClave() {
    return `<div class="lec-aviso"><p><strong>Este artículo está en inglés.</strong> Para traducir el texto completo, agrega tu clave de Groq en Ajustes. Se guarda solo en este dispositivo.</p>
      <button class="boton primario" data-lector="ajustes">Agregar clave</button></div>`;
  }

  function avisoError(e) {
    if (e.tipo === 'cors') {
      return `<div class="lec-aviso"><p><strong>Tu navegador bloquea la descarga directa del artículo.</strong> En el APK de Android funciona sin configurar nada. En la versión web necesitas el proxy gratuito de Cloudflare (instrucciones en el README).</p>
        <button class="boton" data-lector="ajustes">Configurar proxy</button></div>`;
    }
    if (e.tipo === 'sinclave' || e.tipo === 'clave') return avisoClave();
    return `<div class="lec-aviso"><p><strong>No pude cargar el texto completo.</strong> ${esc(e.message || '')}</p>
      <button class="boton" data-lector="reintentar">Reintentar</button></div>`;
  }

  function pintarTraducciones(art, indices) {
    if (lector.modo !== 'es') return;
    const raiz = $('#lector');
    for (const i of indices) {
      const el = raiz.querySelector(`[data-i="${i}"]`);
      if (el && art.tr[i] != null) { el.textContent = art.tr[i]; el.classList.remove('pendiente'); }
    }
  }

  function iniciarTraduccion() {
    const n = lector.nota, art = lector.art;
    if (!n || !art || !necesitaTraduccion(art)) return;
    if (!estado.ajustes.groqKey) { abrirAjustes(); return; }
    lector.modo = 'es';
    cargarArticulo(n, { traducirAhora: true })
      .then(() => { if (esLectorDe(n.id)) pintarLector(); })
      .catch((e) => { if (esLectorDe(n.id)) { toast(e.message); pintarLector(); } });
    pintarLector();
  }

  // ================= GUARDAR Y COMPARTIR =================
  async function alternarGuardado(id) {
    if (estado.guardados.has(id)) {
      await Repo.quitar(id);
      estado.guardados.delete(id);
      toast('Quitada de guardados');
    } else {
      const n = buscarNota(id);
      if (!n) return;
      await Repo.guardar(n);
      estado.guardados.set(id, { ...n, guardadoEn: Date.now() });
      precargarImagen(n.imagen);
      toast('Guardada · descargando el texto completo para leer sin conexión');
      cargarArticulo(n, { traducirAhora: !!estado.ajustes.groqKey })
        .then((art) => { if (!esLectorDe(id)) toast(necesitaTraduccion(art) ? 'Texto guardado (sin traducir: falta la clave de Groq)' : 'Texto completo listo sin conexión'); })
        .catch(() => toast('Guardada solo con el resumen: no pude descargar el texto'));
    }
    render();
    if (esLectorDe(id)) pintarLector();
  }

  function precargarImagen(src) {
    if (!src) return;
    const i = new Image();
    i.referrerPolicy = 'no-referrer';
    i.src = src;
  }

  async function compartir(id) {
    const n = buscarNota(id);
    if (!n) return;
    const texto = `${n.titulo}\n\n${n.resumen || ''}\n\nVía Radar · ${n.fuente}`;
    try {
      const SharePlugin = NATIVO && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
      if (SharePlugin) await SharePlugin.share({ title: n.titulo, text: texto, url: n.url, dialogTitle: 'Compartir noticia' });
      else if (navigator.share) await navigator.share({ title: n.titulo, text: texto, url: n.url });
      else { await navigator.clipboard.writeText(`${texto}\n${n.url}`); toast('Copiado al portapapeles'); }
    } catch {}
  }

  // ================= AJUSTES =================
  function abrirHoja(html) {
    $('#hojaContenido').innerHTML = html;
    abrirCapa('hoja');
  }

  function abrirAjustes() {
    const d = estado.datos;
    const a = estado.ajustes;
    const fuentes = d?.fuentes || [];
    const okN = fuentes.filter((f) => f.ok).length;
    const escalas = [[0.9, 'A−'], [1, 'A'], [1.12, 'A+'], [1.25, 'A++']];
    const enLista = MODELOS.some(([m]) => m === a.modelo);
    abrirHoja(`<h2 class="rotulo" style="margin-top:4px">Lectura completa</h2>
      <label class="campo"><span>Clave de Groq <small>Traduce los artículos en inglés. Se guarda solo en este dispositivo.</small></span>
        <div class="fila"><input id="inKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="gsk_…" value="${esc(a.groqKey)}">
        <button class="boton" data-accion="verclave" aria-label="Mostrar clave">👁</button></div></label>
      <label class="campo"><span>Modelo de traducción</span>
        <select id="inModelo">${MODELOS.map(([m, t]) => `<option value="${m}" ${a.modelo === m ? 'selected' : ''}>${t}</option>`).join('')}
        <option value="__otro" ${enLista ? '' : 'selected'}>Otro (escribir)…</option></select>
        <input id="inModeloOtro" ${enLista ? 'hidden' : ''} placeholder="id del modelo en Groq" value="${enLista ? '' : esc(a.modelo)}" autocapitalize="off" spellcheck="false"></label>
      <div class="fila-botones"><button class="boton" data-accion="probarclave">Probar clave</button></div>
      <div class="ajuste"><div>Traducir al abrir<small>Si lo apagas, el artículo abre en inglés y traduces con un toque</small></div>
        <button class="interruptor" role="switch" aria-checked="${a.autoTraducir}" data-ajuste="autoTraducir" aria-label="Traducir al abrir"></button></div>
      ${NATIVO ? '' : `<label class="campo"><span>Proxy para la versión web <small>Solo hace falta en el navegador. Pega la URL de tu Worker de Cloudflare (ver README).</small></span>
        <input id="inProxy" type="url" autocapitalize="off" spellcheck="false" placeholder="https://radar-proxy.tu-usuario.workers.dev/?k=…" value="${esc(a.proxy)}"></label>`}

      <h2 class="rotulo" style="margin-top:22px">Pantalla</h2>
      <div class="ajuste"><div>Vibración al tocar<small>Respuesta háptica en botones, tarjetas y al escribir</small></div>
        <button class="interruptor" role="switch" aria-checked="${a.vibrar}" data-ajuste="vibrar" aria-label="Vibración"></button></div>
      <div class="ajuste"><div>Tamaño de letra</div>
        <div class="segmentos">${escalas.map(([v, t]) => `<button data-escala="${v}" class="${a.escala === v ? 'activa' : ''}">${t}</button>`).join('')}</div></div>
      <div class="ajuste"><div>Artículos descargados<small>Libera espacio. Los guardados se conservan.</small></div>
        <button class="boton" data-accion="limpiar">Limpiar</button></div>
      <div class="ajuste"><div>Buscar versión nueva<small>${NATIVO ? 'Versión APK: las noticias se actualizan solas' : 'Recarga la app para aplicar cambios'}</small></div>
        <button class="boton" data-accion="recargar">Recargar</button></div>

      <h2 class="rotulo" style="margin-top:20px">Fuentes <small>${okN}/${fuentes.length} respondieron</small></h2>
      <ul class="fuentes">${fuentes.map((f) => `<li><span>${esc(f.nombre)} <span style="opacity:.6">${esc((f.idioma || '').toUpperCase())}</span></span>` +
        `<span class="${f.ok ? 'ok' : 'ko'}" title="${esc(f.error || '')}">${f.ok ? `✓ ${f.n}` : '✗ falló'}</span></li>`).join('')}</ul>
      <div class="pie">
        ${d ? `Generado: ${esc(new Date(d.generado).toLocaleString('es-PE'))}<br>` : ''}
        ${d?.totales ? `Notas: ${d.totales.notas} · traducidas: ${d.totales.traducidas}${d.totales.pendientes ? ` · en cola: ${d.totales.pendientes}` : ''}<br>` : ''}
        Radar v${esc(CONFIG.version || '1.1.0')} · ${NATIVO ? 'Android' : 'PWA'} · noticias cada 3 h
      </div>`);
  }

  function leerCamposAjustes() {
    const k = $('#inKey'); if (k) estado.ajustes.groqKey = k.value.trim();
    const sel = $('#inModelo'), otro = $('#inModeloOtro');
    if (sel) estado.ajustes.modelo = sel.value === '__otro' ? (otro.value.trim() || MODELOS[0][0]) : sel.value;
    const px = $('#inProxy'); if (px) estado.ajustes.proxy = px.value.trim();
  }

  function alCerrarHoja() {
    // si el lector quedó abierto esperando la clave, traduce al volver
    if (!lector.nota) return;
    if (lector.art && necesitaTraduccion(lector.art) && estado.ajustes.groqKey && !enCurso.has(lector.nota.id) && estado.ajustes.autoTraducir) iniciarTraduccion();
    else if (lector.error && (lector.error.tipo === 'cors' ? estado.ajustes.proxy : true)) cargarEnLector();
    else pintarLector();
  }

  function aplicarEscala() { document.documentElement.style.setProperty('--escala', estado.ajustes.escala); }
  const guardarAjustes = () => Repo.set('ajustes', estado.ajustes);

  // ================= EVENTOS =================
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('button, a, .nota, .resumen li')) tic();

    if (t.closest('[data-cerrar]')) return cerrarCapa('hoja');
    const tab = t.closest('#tabs button');
    if (tab) return irA(tab.dataset.vista);
    const ir = t.closest('[data-ir]');
    if (ir) return irA(ir.dataset.ir);
    const g = t.closest('[data-guardar]');
    if (g) return alternarGuardado(g.dataset.guardar);
    const c = t.closest('[data-compartir]');
    if (c) return compartir(c.dataset.compartir);

    const accLector = t.closest('[data-lector]');
    if (accLector) {
      const a = accLector.dataset.lector;
      if (a === 'cerrar') return cerrarCapa('lector');
      if (a === 'idioma') { lector.modo = lector.modo === 'es' ? 'en' : 'es'; return pintarLector(); }
      if (a === 'ajustes') return abrirAjustes();
      if (a === 'traducir') return iniciarTraduccion();
      if (a === 'reintentar') return cargarEnLector();
    }

    const aj = t.closest('[data-ajuste]');
    if (aj) {
      const k = aj.dataset.ajuste;
      estado.ajustes[k] = !estado.ajustes[k];
      aj.setAttribute('aria-checked', estado.ajustes[k]);
      guardarAjustes();
      if (k === 'vibrar' && estado.ajustes.vibrar) tic(20);
      return;
    }
    const es = t.closest('[data-escala]');
    if (es) {
      estado.ajustes.escala = Number(es.dataset.escala);
      aplicarEscala(); guardarAjustes();
      es.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('activa', b === es));
      return;
    }
    const acc = t.closest('[data-accion]');
    if (acc) {
      const a = acc.dataset.accion;
      if (a === 'recargar') return location.reload();
      if (a === 'verclave') { const k = $('#inKey'); k.type = k.type === 'password' ? 'text' : 'password'; return; }
      if (a === 'probarclave') {
        leerCamposAjustes(); guardarAjustes();
        acc.disabled = true; acc.textContent = 'Probando…';
        try {
          const { modelo } = await groq('Responde solo JSON.', '{"t":["Hello world"]} -> traduce al español y responde {"t":["..."]}', { maxTokens: 300 });
          toast(`Clave correcta · ${modelo}`);
        } catch (err) { toast(err.message); }
        acc.disabled = false; acc.textContent = 'Probar clave';
        return;
      }
      if (a === 'limpiar') {
        const todos = await Repo.articulos();
        let n = 0;
        for (const x of todos) if (!estado.guardados.has(x.id)) { await Repo.borrarArticulo(x.id); n++; }
        toast(`${n} artículos borrados`);
        return;
      }
    }
    if (t.closest('a')) return; // enlaces externos siguen su curso
    const nota = t.closest('[data-id]');
    if (nota && !t.closest('#lector') && !t.closest('#hoja')) return abrirLector(nota.dataset.id);
  });

  // campos de ajustes: vibración al escribir y guardado
  document.addEventListener('input', (e) => {
    if (e.target.matches('input, textarea')) tic(4);
    if (e.target.id === 'inModelo') $('#inModeloOtro').hidden = e.target.value !== '__otro';
    if (e.target.closest('#hoja')) { leerCamposAjustes(); guardarAjustes(); }
  });
  document.addEventListener('change', (e) => {
    if (e.target.closest('#hoja')) { leerCamposAjustes(); guardarAjustes(); }
  });

  $('#btnRefrescar').addEventListener('click', () => descargar());
  $('#btnAjustes').addEventListener('click', abrirAjustes);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarCapa(); });
  window.addEventListener('online', () => { renderEstado(); descargar({ silencioso: true }); });
  window.addEventListener('offline', () => { renderEstado(); toast('Sin conexión: modo offline'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - estado.ultimaDescarga > REFRESCO_AUTO_MS) descargar({ silencioso: true });
    if (document.visibilityState === 'hidden' && estado.datos) Repo.set('ultimaVisita', Date.now());
  });

  // ---------- service worker (solo PWA web) ----------
  if (!NATIVO && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const nuevo = reg.installing;
          nuevo && nuevo.addEventListener('statechange', () => {
            if (nuevo.state === 'installed' && navigator.serviceWorker.controller) {
              toast('Nueva versión disponible · toca para actualizar', () => location.reload());
            }
          });
        });
      }).catch(() => {});
    });
  }

  // ---------- ajustes nativos (APK) ----------
  if (NATIVO) {
    try {
      const SB = window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
      if (SB) { SB.setStyle({ style: 'DARK' }); SB.setBackgroundColor({ color: '#0a0b0e' }); }
    } catch {}
  }

  // ---------- arranque ----------
  (async () => {
    const [datos, ajustes, vista, ultimaVisita, guardados] = await Promise.all([
      Repo.get('datos'), Repo.get('ajustes'), Repo.get('vista'), Repo.get('ultimaVisita'), Repo.guardados(),
    ]);
    if (ajustes) estado.ajustes = { ...estado.ajustes, ...ajustes };
    aplicarEscala();
    if (vista && (vista === 'hoy' || vista === 'ultimo' || vista === 'guardados' || CATEGORIAS[vista])) estado.vista = vista;
    estado.ultimaVisita = ultimaVisita || 0;
    for (const g of guardados || []) estado.guardados.set(g.id, g);
    if (datos) { estado.datos = datos; estado.desdeCache = true; }
    render();
    await descargar({ silencioso: true });
    Repo.set('ultimaVisita', Date.now());
    podarArticulos();
  })();
})();
