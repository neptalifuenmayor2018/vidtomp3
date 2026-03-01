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
        file.on('finish', () => { file.close(); fs.chmodSync(YT_DLP, 0o755); resolve(); });
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

// PASO 1: Convertir — devuelve un fileId
app.post('/convert', async (req, res) => {
  const { url, quality = '192' } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'URL inválida' });

  const q = ['128','192','320'].includes(quality) ? quality : '192';
  const fileId = uuidv4();

  if (!fs.existsSync(YT_DLP)) {
    try { await downloadYtDlp(); }
    catch(e) { return res.status(500).json({ error: 'yt-dlp no disponible.' }); }
  }
  try { fs.accessSync(YT_DLP, fs.constants.X_OK); }
  catch { fs.chmodSync(YT_DLP, 0o755); }

  // Obtener título y convertir en paralelo
  // Flags para evitar detección de bot en YouTube
  const antiBot = [
    '--extractor-args "youtube:player_client=web,mweb,ios"',
    '--user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"',
    '--add-header "Accept-Language:en-US,en;q=0.9"',
  ].join(' ');

  const titleCmd = `${YT_DLP} --no-playlist --skip-download --print "%(title)s" ${antiBot} "${url}"`;
  const convertCmd = `${YT_DLP} --no-playlist -x --audio-format mp3 --audio-quality ${q}k --ffmpeg-location "${ffmpegPath}" --no-warnings --no-progress --force-overwrites ${antiBot} -o "/tmp/${fileId}.%(ext)s" "${url}"`;

  console.log(`[convert] ${url} @ ${q}kbps | fileId: ${fileId}`);

  let title = null;
  const titlePromise = new Promise(resolve => {
    exec(titleCmd, { timeout: 20000 }, (err, stdout) => {
      if (!err && stdout.trim()) {
        title = stdout.trim().replace(/[\/\\:*?"<>|]/g,'').trim().substring(0, 120);
      }
      resolve();
    });
  });

  const convertPromise = new Promise((resolve, reject) => {
    exec(convertCmd, { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message);
      else resolve();
    });
  });

  try {
    await Promise.all([titlePromise, convertPromise]);
    const outPath = `/tmp/${fileId}.mp3`;
    if (!fs.existsSync(outPath)) return res.status(500).json({ error: 'Archivo no generado.' });
    // Devolver fileId y título — el frontend descarga con /download/:fileId
    res.json({ fileId, title: title || null });
  } catch(err) {
    console.error('[error]', err);
    res.status(500).json({ error: 'No se pudo convertir el video.', detail: err });
  }
});

// PASO 2: Descargar el archivo por fileId
app.get('/download/:fileId', (req, res) => {
  const { fileId } = req.params;
  // Validar que el fileId sea un UUID válido para seguridad
  if (!/^[0-9a-f-]{36}$/.test(fileId)) return res.status(400).send('ID inválido');

  const filePath = `/tmp/${fileId}.mp3`;
  if (!fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado o expirado');

  const title = req.query.title ? decodeURIComponent(req.query.title) : 'audio';
  const safeName = title.replace(/[\/\\:*?"<>|]/g,'').trim() || 'audio';

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.mp3"`);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('end', () => fs.unlink(filePath, () => {}));
  stream.on('error', () => fs.unlink(filePath, () => {}));
});

app.listen(PORT, () => console.log(`VidToMP3 corriendo en puerto ${PORT}`));
