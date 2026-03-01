const express = require('express');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Guardar yt-dlp en /tmp donde siempre hay permisos de escritura y ejecución
const YT_DLP = '/tmp/yt-dlp';

function downloadYtDlp() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(YT_DLP)) {
      console.log('[init] yt-dlp ya existe en /tmp');
      return resolve();
    }
    console.log('[init] Descargando yt-dlp...');
    const file = fs.createWriteStream(YT_DLP);

    function get(url, depth = 0) {
      if (depth > 5) return reject(new Error('Demasiados redirects'));
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          return get(res.headers.location, depth + 1);
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          fs.chmodSync(YT_DLP, 0o755);
          console.log('[init] yt-dlp listo en /tmp');
          resolve();
        });
      }).on('error', e => {
        fs.unlink(YT_DLP, () => {});
        reject(e);
      });
    }

    get('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
  });
}

function isValidUrl(url) {
  try { new URL(url); return true; } catch { return false; }
}

// Iniciar descarga al arrancar
downloadYtDlp()
  .then(() => console.log('[init] Servidor listo'))
  .catch(e => console.error('[init] Error descargando yt-dlp:', e.message));

app.post('/convert', async (req, res) => {
  const { url, quality = '192' } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'URL inválida' });

  const q = ['128','192','320'].includes(quality) ? quality : '192';
  const fileId = uuidv4();
  const outTemplate = `/tmp/${fileId}.%(ext)s`;
  const outPath = `/tmp/${fileId}.mp3`;

  // Si yt-dlp no está listo aún, esperar
  if (!fs.existsSync(YT_DLP)) {
    try { await downloadYtDlp(); }
    catch(e) { return res.status(500).json({ error: 'yt-dlp no disponible, intenta en 30 segundos.' }); }
  }

  // Verificar permisos
  try { fs.accessSync(YT_DLP, fs.constants.X_OK); }
  catch { fs.chmodSync(YT_DLP, 0o755); }

  // Obtener título del video primero
  let videoTitle = fileId;
  try {
    videoTitle = execSync(`${YT_DLP} --get-title --no-playlist "${url}"`, { timeout: 15000 })
      .toString().trim()
      .replace(/[^\w\s\-áéíóúñüÁÉÍÓÚÑÜ]/g, '') // quitar caracteres inválidos
      .replace(/\s+/g, '_')
      .substring(0, 100); // máximo 100 caracteres
  } catch(e) {
    console.log('[convert] No se pudo obtener título, usando ID');
  }

  const cmd = [
    YT_DLP,
    '--no-playlist',
    '-x',
    '--audio-format mp3',
    `--audio-quality ${q}k`,
    `--ffmpeg-location "${ffmpegPath}"`,
    '--no-warnings',
    '--no-progress',
    '--force-overwrites',
    `-o "${outTemplate}"`,
    `"${url}"`
  ].join(' ');

  console.log(`[convert] ${url} @ ${q}kbps`);

  exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
    console.log('[stdout]', stdout);
    console.log('[stderr]', stderr);

    if (err) {
      console.error('[error]', err.message);
      return res.status(500).json({ error: 'No se pudo convertir el video.', detail: stderr });
    }

    const files = fs.readdirSync('/tmp').filter(f => f.startsWith(fileId));
    const mp3 = files.find(f => f.endsWith('.mp3'));
    const finalPath = mp3 ? `/tmp/${mp3}` : outPath;

    if (!fs.existsSync(finalPath)) {
      return res.status(500).json({ error: 'Archivo no generado.', detail: files.join(', ') || 'ninguno' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${videoTitle}.mp3"`);
    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(finalPath, () => {}));
    stream.on('error', () => fs.unlink(finalPath, () => {}));
  });
});

app.listen(PORT, () => console.log(`VidToMP3 corriendo en puerto ${PORT}`));
