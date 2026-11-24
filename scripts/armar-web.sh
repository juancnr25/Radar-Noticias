#!/usr/bin/env bash
# Copia los archivos de la app web a la carpeta indicada.
# Lo usan los dos workflows: si agregas archivos a la app, edita solo esta lista.
# Uso: bash scripts/armar-web.sh CARPETA_DESTINO
set -euo pipefail
DEST="${1:?Indica la carpeta destino}"
mkdir -p "$DEST"
ARCHIVOS="index.html styles.css app.js config.js sw.js manifest.webmanifest"
CARPETAS="icons vendor"
for f in $ARCHIVOS; do cp "$f" "$DEST/"; done
for d in $CARPETAS; do cp -r "$d" "$DEST/"; done
echo "App web copiada en $DEST"
