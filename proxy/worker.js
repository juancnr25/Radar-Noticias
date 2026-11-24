// Radar · proxy de lectura para la versión web (Cloudflare Workers, plan gratuito).
// El navegador no deja que una página descargue artículos de otros sitios (CORS).
// Este Worker los descarga por ti. El APK de Android no lo necesita.
//
// Configuración: en el Worker agrega la variable secreta CLAVE con una palabra larga
// y en Radar pega: https://TU-WORKER.workers.dev/?k=ESA_PALABRA

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET') return new Response('Método no permitido', { status: 405, headers: cors });

    const u = new URL(req.url);
    if (env.CLAVE && u.searchParams.get('k') !== env.CLAVE) {
      return new Response('No autorizado', { status: 401, headers: cors });
    }
    const destino = u.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(destino)) return new Response('Falta el parámetro url', { status: 400, headers: cors });

    const r = await fetch(destino, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
      },
      cf: { cacheTtl: 900, cacheEverything: true },
    });
    const tipo = r.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(tipo)) {
      return new Response('Solo se permiten páginas HTML', { status: 415, headers: cors });
    }
    return new Response(r.body, {
      status: r.status,
      headers: { ...cors, 'Content-Type': tipo, 'Cache-Control': 'public, max-age=900' },
    });
  },
};
