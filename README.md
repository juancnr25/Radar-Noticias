# 📡 Radar · Ciencia, tecnología e historia

PWA de noticias diarias en español: **Tecnología, Hallazgos, Ciencia, Historia y Lo último**, con **Resumen del día**, **Un día como hoy** (efemérides), **lectura del artículo completo traducido** y **Guardados offline**. Lo que llega en inglés se traduce con Groq.

El mismo repositorio genera:
- la **PWA** publicada en GitHub Pages (Android e iPhone), y
- el **APK de Android** (Capacitor), publicado en *Releases*.

## Cómo funciona

```
GitHub Actions (cada 3 h)
  ├─ lee 21 fuentes (RSS y sitios sin RSS como National Geographic) (scripts/fuentes.json)
  ├─ traduce y resume las notas en inglés con Groq  (reutiliza lo ya traducido)
  ├─ arma el Resumen del día y las efemérides (Wikipedia en español)
  └─ publica data/noticias.json + la app en GitHub Pages
PWA y APK  →  leen ese JSON  →  lo guardan en IndexedDB para leer sin conexión

Al abrir una noticia (en tu celular):
  descarga la página original → extrae el texto (Mozilla Readability)
  → si está en inglés, lo traduce por partes con tu clave de Groq
  → guarda el artículo en el dispositivo
```

El sitio público solo publica títulos y resúmenes. El texto completo se descarga y traduce en tu dispositivo, como el modo lectura de un navegador, así no republicas artículos ajenos en tu GitHub Pages.

## Puesta en marcha (una sola vez)

1. **Crea el repositorio** `radar-noticias` en GitHub, **público** (Pages gratis exige repo público).
2. **Sube todos los archivos** de esta carpeta, incluida `.github/workflows/`.
3. **Activa Pages:** *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
4. **Agrega tu clave de Groq:** *Settings → Secrets and variables → Actions → New repository secret*
   - Nombre: `GROQ_API_KEY`
   - Valor: tu clave `gsk_...` (la sacas en console.groq.com → API Keys)
5. **Primera corrida:** *Actions → Actualizar noticias y publicar → Run workflow*. Tarda 3 a 6 minutos.
6. Abre `https://TU_USUARIO.github.io/radar-noticias/`.

> La primera corrida traduce hasta 60 notas. Las demás entran en las corridas siguientes (cada 3 h), así no agotas el límite gratuito de Groq.

### Instalar la PWA
- **Android (Chrome):** menú ⋮ → *Instalar app*.
- **iPhone (Safari):** botón Compartir → *Agregar a inicio*.

## APK de Android

1. *Actions → Compilar APK (Android) → Run workflow*.
2. Al terminar (unos 8 minutos), entra a **Releases** y descarga `Radar-1.0.X.apk`.
3. Ábrelo en tu celular y permite *instalar apps de origen desconocido*.

El APK lleva la app adentro y descarga las noticias desde tu GitHub Pages, así que **primero debe funcionar la PWA**.

### Firma propia del APK (recomendado)

Sin firma propia el workflow genera un APK *debug* y reutiliza su firma durante 7 días. Si pasa más tiempo, Android rechaza instalar la versión nueva encima y tendrías que desinstalar la anterior (pierdes tus guardados). Para evitarlo, crea tu firma una vez en **Termux**:

```bash
pkg install openjdk-17
keytool -genkeypair -v -keystore radar.jks -alias radar -keyalg RSA -keysize 2048 \
  -validity 10000 -dname "CN=Radar, C=PE"
base64 -w0 radar.jks > radar.b64
cat radar.b64          # copia todo este texto
```

Luego crea estos secretos en el repositorio:

| Secreto | Valor |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | el contenido de `radar.b64` |
| `KEYSTORE_PASSWORD` | la contraseña que pusiste en keytool |
| `KEY_ALIAS` | `radar` |
| `KEY_PASSWORD` | la misma contraseña (si usaste una sola) |

Guarda `radar.jks` en un lugar seguro. Si lo pierdes, no podrás actualizar el APK sin desinstalar.

## Leer la noticia completa

1. Abre Radar → **Ajustes** (ícono de controles, arriba a la derecha).
2. En **Clave de Groq** pega tu clave `gsk_...` y toca **Probar clave**.
3. Toca cualquier noticia: verás el texto completo. Si viene en inglés, se traduce por partes mientras lees. El botón **ES / EN** cambia entre traducción y original.
4. Toca el marcador para **guardar**: se descarga el texto completo y lo lees sin conexión.

| Dónde | ¿Funciona el texto completo? |
|---|---|
| **APK Android** | Sí, sin configurar nada más. |
| **PWA en el navegador** | El navegador bloquea descargar páginas de otros sitios (CORS). Necesitas el proxy gratuito de abajo. Sin él, la PWA muestra el resumen y el enlace. |

Límites: los sitios con muro de pago (algunas notas de National Geographic, MIT Technology Review o Wired) pueden entregar solo el inicio del texto. Groq gratis tiene un tope diario por modelo; si lo agotas, la app pasa sola a `gpt-oss-20b`.

### Proxy para la PWA web (opcional, gratis)

1. Crea una cuenta en dash.cloudflare.com → **Workers & Pages → Create → Create Worker**. Ponle de nombre `radar-proxy` y toca **Deploy**.
2. Toca **Edit code**, borra todo, pega el contenido de `proxy/worker.js` y toca **Deploy**.
3. En el Worker: **Settings → Variables and Secrets → Add** → tipo *Secret*, nombre `CLAVE`, valor una palabra larga que inventes.
4. En Radar → Ajustes → **Proxy para la versión web**, pega: `https://radar-proxy.TU-USUARIO.workers.dev/?k=TU_CLAVE`

La clave evita que otras personas usen tu Worker.

## Ajustes opcionales (*Settings → Secrets and variables → Actions → Variables*)

| Variable | Para qué | Valor por defecto |
|---|---|---|
| `GROQ_MODEL` | modelo principal | `openai/gpt-oss-120b` |
| `GROQ_MODEL_RESPALDO` | modelo si el principal agota su límite diario | `openai/gpt-oss-20b` |
| `MAX_TRADUCIR` | notas nuevas a traducir por corrida | `60` |
| `APP_ID` | identificador del APK | `com.radar.noticias` |
| `SITE_URL` | si usas un dominio propio para Pages | `https://usuario.github.io/repo/` |

## Agregar o quitar fuentes

Edita `scripts/fuentes.json`. Para sitios **sin RSS**, como National Geographic, usa `"tipo": "html"`: el workflow lee la página indicada, detecta los enlaces a artículos y toma título, resumen e imagen de cada uno. Con `patron` limitas qué enlaces cuentan y con `categoriaPorRuta` asignas la categoría según la carpeta de la URL. Cada fuente lleva `categoria` (`tecnologia`, `hallazgos`, `ciencia`, `historia`), `idioma` (`es` no se traduce, `en` sí), `max` (notas por fuente) y `dias` (antigüedad máxima). En la app, **Ajustes → Fuentes** muestra cuáles respondieron en la última corrida.

## Cambios en la app

Cada vez que modifiques `index.html`, `app.js` o `styles.css`, sube el número de `CACHE_VERSION` en `sw.js` para que los celulares descarguen la versión nueva. Si agregas archivos o carpetas a la app, añádelos en `scripts/armar-web.sh`: los dos workflows usan esa lista.

## Problemas comunes

| Síntoma | Causa y solución |
|---|---|
| Solo aparecen fuentes en español | Falta el secreto `GROQ_API_KEY` o es inválido. La app lo avisa arriba. |
| La página da 404 | Pages no está en *Source: GitHub Actions*, o la primera corrida no terminó. |
| El workflow programado dejó de correr | GitHub lo pausa tras 60 días sin actividad. El job `mantener-activo` hace un commit vacío a los 45 días para evitarlo. |
| El APK abre pero sin noticias | La PWA aún no está publicada, o usas dominio propio sin la variable `SITE_URL`. |
| "Tu navegador bloquea la descarga directa" | Estás en la PWA web sin proxy. Usa el APK o configura el Worker. |
| "No encontré el texto del artículo" | Muro de pago o página armada con JavaScript. Toca **Ver en …** para abrir la original. |
| Una fuente sale "✗ falló" | El sitio cambió su RSS o bloquea robots. Cambia la URL en `fuentes.json` o elimínala. |

## Estructura

```
index.html · styles.css · app.js · config.js · sw.js · manifest.webmanifest
icons/                     íconos PWA (incluye apple-touch-icon 180×180 opaco)
vendor/Readability.js      extractor de texto de Mozilla (licencia Apache 2.0)
apk/assets/                logo para generar íconos y splash del APK
apk/capacitor.plantilla.json  configuración del APK (activa CapacitorHttp)
proxy/worker.js            proxy opcional de Cloudflare para la PWA web
scripts/actualizar.mjs     recolector + traducción + resumen + efemérides
scripts/armar-web.sh       lista de archivos que se publican
scripts/fuentes.json       fuentes RSS y sitios sin RSS
.github/workflows/         actualizar-noticias.yml · compilar-apk.yml
```
