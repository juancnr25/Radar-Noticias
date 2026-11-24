# 📡 Radar · Ciencia, tecnología e historia

PWA de noticias diarias en español: **Tecnología, Hallazgos, Ciencia, Historia y Lo último**, con **Resumen del día**, **Un día como hoy** (efemérides) y **Guardados offline**. Lo que llega en inglés se traduce y resume con Groq.

El mismo repositorio genera:
- la **PWA** publicada en GitHub Pages (Android e iPhone), y
- el **APK de Android** (Capacitor), publicado en *Releases*.

## Cómo funciona

```
GitHub Actions (cada 3 h)
  ├─ descarga 15 fuentes RSS (scripts/fuentes.json)
  ├─ traduce y resume las notas en inglés con Groq  (reutiliza lo ya traducido)
  ├─ arma el Resumen del día y las efemérides (Wikipedia en español)
  └─ publica data/noticias.json + la app en GitHub Pages
PWA y APK  →  leen ese JSON  →  lo guardan en IndexedDB para leer sin conexión
```

Tu clave de Groq vive solo como secreto de GitHub. La app nunca la ve.

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

## Ajustes opcionales (*Settings → Secrets and variables → Actions → Variables*)

| Variable | Para qué | Valor por defecto |
|---|---|---|
| `GROQ_MODEL` | modelo principal | `openai/gpt-oss-120b` |
| `GROQ_MODEL_RESPALDO` | modelo si el principal agota su límite diario | `openai/gpt-oss-20b` |
| `MAX_TRADUCIR` | notas nuevas a traducir por corrida | `60` |
| `APP_ID` | identificador del APK | `com.radar.noticias` |
| `SITE_URL` | si usas un dominio propio para Pages | `https://usuario.github.io/repo/` |

## Agregar o quitar fuentes

Edita `scripts/fuentes.json`. Cada fuente lleva `categoria` (`tecnologia`, `hallazgos`, `ciencia`, `historia`), `idioma` (`es` no se traduce, `en` sí), `max` (notas por fuente) y `dias` (antigüedad máxima). En la app, **Ajustes → Fuentes** muestra cuáles respondieron en la última corrida.

## Cambios en la app

Cada vez que modifiques `index.html`, `app.js` o `styles.css`, sube el número de `CACHE_VERSION` en `sw.js` para que los celulares descarguen la versión nueva.

## Problemas comunes

| Síntoma | Causa y solución |
|---|---|
| Solo aparecen fuentes en español | Falta el secreto `GROQ_API_KEY` o es inválido. La app lo avisa arriba. |
| La página da 404 | Pages no está en *Source: GitHub Actions*, o la primera corrida no terminó. |
| El workflow programado dejó de correr | GitHub lo pausa tras 60 días sin actividad. El job `mantener-activo` hace un commit vacío a los 45 días para evitarlo. |
| El APK abre pero sin noticias | La PWA aún no está publicada, o usas dominio propio sin la variable `SITE_URL`. |
| Una fuente sale "✗ falló" | El sitio cambió su RSS o bloquea robots. Cambia la URL en `fuentes.json` o elimínala. |

## Estructura

```
index.html · styles.css · app.js · config.js · sw.js · manifest.webmanifest
icons/                     íconos PWA (incluye apple-touch-icon 180×180 opaco)
apk/assets/                logo para generar íconos y splash del APK
scripts/actualizar.mjs     recolector + traducción + resumen + efemérides
scripts/fuentes.json       lista de fuentes RSS
.github/workflows/         actualizar-noticias.yml · compilar-apk.yml
```
