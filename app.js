/* Radar · PWA de noticias de ciencia, tecnología e historia (vanilla JS, offline-first) */
(() => {
  'use strict';

  const CONFIG = window.RADAR_CONFIG || {};
  const DATA_URL = CONFIG.dataUrl || 'data/noticias.json';
  const NATIVO = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const CATEGORIAS = {
    tecnologia: 'Tecnología',
    hallazgos: 'Hallazgos',
    ciencia: 'Ciencia',
    historia: 'Historia',
  };
  const REFRESCO_AUTO_MS = 30 * 60 * 1000;

  // ---------- repositorio IndexedDB ----------
  const Repo = (() => {
    let dbp;
    const abrir = () => dbp || (dbp = new Promise((ok, mal) => {
      const r = indexedDB.open('radar', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('guardados')) db.createObjectStore('guardados', { keyPath: 'id' });
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
    };
  })();

  // ---------- estado ----------
  const estado = {
    datos: null,
    desdeCache: false,
    vista: 'hoy',
    guardados: new Map(),
    ajustes: { vibrar: true, escala: 1 },
    ultimaVisita: 0,
    ultimaDescarga: 0,
    cargando: false,
  };

  // ---------- utilidades ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const urlSegura = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');

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

  const porId = () => new Map((estado.datos?.items || []).map((n) => [n.id, n]));

  // ---------- render ----------
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

  function esqueleto() {
    return '<div class="lista" style="margin-top:18px">' + '<div class="esq"></div>'.repeat(5) + '</div>';
  }

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
    let html = `<h2 class="titulo-vista">Guardados</h2><p class="sub-vista mono">${items.length} notas · disponibles sin conexión</p>`;
    if (!items.length) return html + vacio('☆', 'Abre una noticia y toca "Guardar" para leerla después, incluso sin internet.');
    return html + '<div class="lista">' + items.map((n) => tarjeta(n)).join('') + '</div>';
  }

  const vacio = (icono, txt) => `<div class="vacio"><div class="grande">${icono}</div><p>${esc(txt)}</p></div>`;

  function render() {
    renderEstado();
    renderBanner();
    const v = estado.vista;
    const html = v === 'hoy' ? vistaHoy() : v === 'guardados' ? vistaGuardados() : vistaLista(v === 'ultimo' ? null : v);
    $('#vista').innerHTML = html;
    $('#numGuardados').textContent = estado.guardados.size || '';
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('activa', b.dataset.vista === v));
  }

  function irA(vista) {
    estado.vista = vista;
    render();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    const tab = document.querySelector(`#tabs button[data-vista="${vista}"]`);
    tab && tab.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    Repo.set('vista', vista);
  }

  // ---------- hoja inferior ----------
  let hojaAbierta = false;
  function abrirHoja(html) {
    $('#hojaContenido').innerHTML = html;
    $('#hoja').hidden = false;
    document.body.style.overflow = 'hidden';
    if (!hojaAbierta) { history.pushState({ hoja: true }, ''); hojaAbierta = true; }
  }
  function cerrarHoja(desdeHistorial = false) {
    if (!hojaAbierta) return;
    $('#hoja').hidden = true;
    document.body.style.overflow = '';
    hojaAbierta = false;
    if (!desdeHistorial) history.back();
  }
  window.addEventListener('popstate', () => { if (hojaAbierta) cerrarHoja(true); });

  function abrirNota(id) {
    const n = porId().get(id) || estado.guardados.get(id);
    if (!n) return;
    const guardada = estado.guardados.has(id);
    abrirHoja(`<article class="det">
      ${n.imagen ? `<img class="det-img" src="${esc(urlSegura(n.imagen))}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      ${metaHtml(n)}
      <h2>${esc(n.titulo)}</h2>
      ${n.resumen ? `<p class="texto">${esc(n.resumen)}</p>` : ''}
      ${n.traducido && n.tituloOriginal ? `<p class="original">Traducido y resumido del inglés.<br>Título original: <em>${esc(n.tituloOriginal)}</em></p>` : ''}
      <div class="botones">
        <a class="boton primario" href="${esc(urlSegura(n.url))}" target="_blank" rel="noopener">Leer en ${esc(n.fuente)}</a>
        <button class="boton${guardada ? ' activo' : ''}" data-guardar="${esc(n.id)}" aria-label="${guardada ? 'Quitar de guardados' : 'Guardar'}">
          <svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z" fill="${guardada ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        </button>
        <button class="boton" data-compartir="${esc(n.id)}" aria-label="Compartir">
          <svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </article>`);
  }

  async function alternarGuardado(id) {
    if (estado.guardados.has(id)) {
      await Repo.quitar(id);
      estado.guardados.delete(id);
      toast('Quitada de guardados');
    } else {
      const n = porId().get(id);
      if (!n) return;
      await Repo.guardar(n);
      estado.guardados.set(id, { ...n, guardadoEn: Date.now() });
      toast('Guardada para leer sin conexión');
      precargarImagen(n.imagen);
    }
    render();
    if (hojaAbierta) abrirNota(id);
  }

  function precargarImagen(src) {
    if (!src) return;
    const i = new Image();
    i.referrerPolicy = 'no-referrer';
    i.src = src;
  }

  async function compartir(id) {
    const n = porId().get(id) || estado.guardados.get(id);
    if (!n) return;
    const texto = `${n.titulo}\n\n${n.resumen || ''}\n\nVía Radar · ${n.fuente}`;
    try {
      const SharePlugin = NATIVO && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
      if (SharePlugin) await SharePlugin.share({ title: n.titulo, text: texto, url: n.url, dialogTitle: 'Compartir noticia' });
      else if (navigator.share) await navigator.share({ title: n.titulo, text: texto, url: n.url });
      else { await navigator.clipboard.writeText(`${texto}\n${n.url}`); toast('Copiado al portapapeles'); }
    } catch {}
  }

  // ---------- ajustes ----------
  function abrirAjustes() {
    const d = estado.datos;
    const fuentes = d?.fuentes || [];
    const okN = fuentes.filter((f) => f.ok).length;
    const escalas = [[0.9, 'A−'], [1, 'A'], [1.12, 'A+'], [1.25, 'A++']];
    abrirHoja(`<h2 class="rotulo" style="margin-top:4px">Ajustes</h2>
      <div class="ajuste"><div>Vibración al tocar<small>Respuesta háptica en botones y tarjetas</small></div>
        <button class="interruptor" role="switch" aria-checked="${estado.ajustes.vibrar}" data-ajuste="vibrar" aria-label="Vibración"></button></div>
      <div class="ajuste"><div>Tamaño de letra</div>
        <div class="segmentos">${escalas.map(([v, t]) => `<button data-escala="${v}" class="${estado.ajustes.escala === v ? 'activa' : ''}">${t}</button>`).join('')}</div></div>
      <div class="ajuste"><div>Buscar versión nueva<small>${NATIVO ? 'Versión APK: las noticias se actualizan solas' : 'Recarga la app para aplicar cambios'}</small></div>
        <button class="boton" data-accion="recargar">Recargar</button></div>
      <h2 class="rotulo" style="margin-top:20px">Fuentes <small>${okN}/${fuentes.length} respondieron</small></h2>
      <ul class="fuentes">${fuentes.map((f) => `<li><span>${esc(f.nombre)} <span style="opacity:.6">${esc(f.idioma.toUpperCase())}</span></span>` +
        `<span class="${f.ok ? 'ok' : 'ko'}" title="${esc(f.error || '')}">${f.ok ? `✓ ${f.n}` : '✗ falló'}</span></li>`).join('')}</ul>
      <div class="pie">
        ${d ? `Generado: ${esc(new Date(d.generado).toLocaleString('es-PE'))}<br>` : ''}
        ${d?.totales ? `Notas: ${d.totales.notas} · traducidas: ${d.totales.traducidas}${d.totales.pendientes ? ` · en cola: ${d.totales.pendientes}` : ''}<br>` : ''}
        ${d?.modelo ? `Traducción: Groq · ${esc(d.modelo)}<br>` : ''}
        Radar v${esc(CONFIG.version || '1.0.0')} · ${NATIVO ? 'Android' : 'PWA'} · se actualiza cada 3 h
      </div>`);
  }

  function aplicarEscala() { document.documentElement.style.setProperty('--escala', estado.ajustes.escala); }
  const guardarAjustes = () => Repo.set('ajustes', estado.ajustes);

  // ---------- eventos ----------
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('button, a, .nota, .resumen li')) tic();

    if (t.closest('[data-cerrar]')) return cerrarHoja();
    const tab = t.closest('#tabs button');
    if (tab) return irA(tab.dataset.vista);
    const ir = t.closest('[data-ir]');
    if (ir) return irA(ir.dataset.ir);
    const g = t.closest('[data-guardar]');
    if (g) return alternarGuardado(g.dataset.guardar);
    const c = t.closest('[data-compartir]');
    if (c) return compartir(c.dataset.compartir);
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
    if (t.closest('[data-accion="recargar"]')) return location.reload();
    if (t.closest('a')) return; // enlaces externos siguen su curso
    const nota = t.closest('[data-id]');
    if (nota && !$('#hoja').contains(nota)) return abrirNota(nota.dataset.id);
  });

  $('#btnRefrescar').addEventListener('click', () => descargar());
  $('#btnAjustes').addEventListener('click', abrirAjustes);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarHoja(); });
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
  })();
})();
