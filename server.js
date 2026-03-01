const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
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

const YT_DLP = '/tmp/yt-dlp';

function downloadYtDlp() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(YT_DLP)) return resolve();
    console.log('[init] Descargando yt-dlp...');
    const file = fs.createWriteStream(YT_DLP);
    function get(url, depth = 0) {
      if (depth > 5) return reject(new Error('Demasiados redirects'));
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if ([301,302,307,308].includes(res.statusCode)) return get(res.headers.location, depth + 1);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          fs.chmodSync(YT_DLP, 0o755);
          console.log('[init] yt-dlp listo');
          resolve();
        });
      }).on('error', e => { fs.unlink(YT_DLP, ()=>{}); reject(e); });
    }
    get('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
  });
}

function isValidUrl(url) {
  try { new URL(url); return true; } catch { return false; }
}

downloadYtDlp()
  .then(() => console.log('[init] Servidor listo'))
  .catch(e => console.error('[init] Error:', e.message));

app.post('/convert', async (req, res) => {
  const { url, quality = '192' } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'URL inválida' });

  const q = ['128','192','320'].includes(quality) ? quality : '192';
  const fileId = uuidv4();
  // Siempre guardamos con ID fijo, luego renombramos
  const outPath = `/tmp/${fileId}.mp3`;

  if (!fs.existsSync(YT_DLP)) {
    try { await downloadYtDlp(); }
    catch(e) { return res.status(500).json({ error: 'yt-dlp no disponible.' }); }
  }

  try { fs.accessSync(YT_DLP, fs.constants.X_OK); }
  catch { fs.chmodSync(YT_DLP, 0o755); }

  // Paso 1: convertir con nombre fijo (esto SIEMPRE funciona)
  const convertCmd = [
    YT_DLP,
    '--no-playlist',
    '-x',
    '--audio-format mp3',
    `--audio-quality ${q}k`,
    `--ffmpeg-location "${ffmpegPath}"`,
    '--no-warnings',
    '--no-progress',
    '--force-overwrites',
    `-o "/tmp/${fileId}.%(ext)s"`,
    `"${url}"`
  ].join(' ');

  // Paso 2: obtener título por separado con --no-simulate --skip-download
  const titleCmd = [
    YT_DLP,
    '--no-playlist',
    '--skip-download',
    '--print "%(title)s"',
    `"${url}"`
  ].join(' ');

  console.log(`[convert] Iniciando: ${url} @ ${q}kbps`);

  // Ejecutar conversión y obtención de título en paralelo
  const convertPromise = new Promise((resolve, reject) => {
    exec(convertCmd, { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) reject({ err, stderr });
      else resolve({ stdout, stderr });
    });
  });

  const titlePromise = new Promise((resolve) => {
    exec(titleCmd, { timeout: 20000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(null);
      } else {
        // Limpiar título para nombre de archivo
        const title = stdout.trim()
          .replace(/[\/\\:*?"<>|]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 120);
        resolve(title || null);
      }
    });
  });

  try {
    // Esperar ambos en paralelo
    const [, title] = await Promise.all([convertPromise, titlePromise]);

    // Verificar que el archivo existe
    if (!fs.existsSync(outPath)) {
      const files = fs.readdirSync('/tmp').filter(f => f.startsWith(fileId));
      console.log('[convert] archivos en /tmp:', files);
      if (!files.length) return res.status(500).json({ error: 'Archivo no generado.' });
    }

    const downloadName = title ? `${title}.mp3` : `audio_${fileId}.mp3`;
    console.log(`[convert] Enviando como: ${downloadName}`);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(outPath, () => {}));
    stream.on('error', () => fs.unlink(outPath, () => {}));

  } catch({ err, stderr }) {
    console.error('[error]', err.message);
    console.error('[stderr]', stderr);
    res.status(500).json({ error: 'No se pudo convertir el video.', detail: stderr });
  }
});

app.listen(PORT, () => console.log(`VidToMP3 corriendo en puerto ${PORT}`));
