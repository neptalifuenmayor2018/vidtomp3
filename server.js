const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

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
const COOKIES_FILE = '/tmp/cookies.txt';
const DENO_BIN = '/tmp/deno';

function ensureCookies() {
  try {
    if (!fs.existsSync(COOKIES_FILE)) {
      fs.writeFileSync(COOKIES_FILE, '# Netscape HTTP Cookie File\n');
    }
  } catch (err) {
    console.error('[cookies] Fallo al crear archivo:', err.message);
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) return resolve();
    const file = fs.createWriteStream(dest);
    file.on('error', err => reject(err));
    
    function get(u, depth = 0) {
      if (depth > 10) return reject(new Error('Demasiados redirects'));
      https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if ([301,302,307,308].includes(res.statusCode)) return get(res.headers.location, depth + 1);
        res.pipe(file);
        file.on('finish', () => { 
          file.close(); 
          try { fs.chmodSync(dest, 0o755); } catch (e) {}
          resolve(); 
        });
      }).on('error', e => { 
        try { fs.unlinkSync(dest); } catch (err) {} 
        reject(e); 
      });
    }
    get(url);
  });
}

async function ensureDeps() {
  if (!fs.existsSync(YT_DLP)) {
    console.log('[init] Descargando yt-dlp...');
    await downloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux', YT_DLP);
  }
  if (!fs.existsSync(DENO_BIN)) {
    console.log('[init] Descargando deno...');
    try {
      await downloadFile('https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip', '/tmp/deno.zip');
      const zip = new AdmZip('/tmp/deno.zip');
      zip.extractEntryTo('deno', '/tmp', false, true);
      fs.chmodSync(DENO_BIN, 0o755);
    } catch(e) {
      console.error('[init] deno falló:', e.message);
    }
  }
}

function isValidUrl(url) {
  try { new URL(url); return true; } catch { return false; }
}

ensureDeps().then(() => ensureCookies()).catch(e => console.error('[init]', e.message));

app.post('/set-cookies', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
  try {
    if (!req.body) return res.status(400).json({ error: 'No se recibieron cookies' });
    fs.writeFileSync(COOKIES_FILE, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo guardar el archivo de cookies.' });
  }
});

app.post('/convert', async (req, res, next) => {
  try {
    const { url, quality = '192' } = req.body;
    if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'URL inválida' });

    const q = ['128','192','320'].includes(quality) ? quality : '192';
    const fileId = uuidv4();

    if (!fs.existsSync(YT_DLP)) {
      await ensureDeps();
    }
    
    try { fs.accessSync(YT_DLP, fs.constants.X_OK); }
    catch { fs.chmodSync(YT_DLP, 0o755); }

    ensureCookies();

    const denoFlag = fs.existsSync(DENO_BIN) ? `--js-runtimes deno:${DENO_BIN}` : '';

    const baseFlags = [
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--force-overwrites',
      '--no-check-certificates',
      `--cookies "${COOKIES_FILE}"`,
      '-f "140/251/250/249/139/bestaudio/best"',
      denoFlag,
    ].join(' ');

    const titleCmd = `${YT_DLP} --no-playlist --no-warnings --no-check-certificates --cookies "${COOKIES_FILE}" ${denoFlag} --skip-download --print "%(title)s" "${url}"`;
    const convertCmd = `${YT_DLP} ${baseFlags} -x --audio-format mp3 --audio-quality ${q}k -o "/tmp/${fileId}.%(ext)s" "${url}"`;

    let title = null;
    const titlePromise = new Promise(resolve => {
      exec(titleCmd, { timeout: 20000 }, (err, stdout) => {
        if (!err && stdout.trim()) {
          title = stdout.trim().replace(/[\/\\:*?"<>|]/g, '').trim().substring(0, 120);
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

    await Promise.all([titlePromise, convertPromise]);
    
    const files = fs.readdirSync('/tmp').filter(f => f.startsWith(fileId) && f.endsWith('.mp3'));
    if (!files.length) return res.status(500).json({ error: 'Archivo no generado.' });
    
    res.json({ fileId, title: title || null });

  } catch(err) {
    let msg = 'No se pudo convertir el video.';
    const errStr = String(err);
    if (errStr.includes('Sign in') || errStr.includes('bot')) msg = 'Sube tus cookies de YouTube nuevamente.';
    if (errStr.includes('DRM')) msg = 'Este video está protegido con DRM.';
    res.status(500).json({ error: msg, detail: errStr.substring(0, 300) });
  }
});

app.get('/download/:fileId', (req, res, next) => {
  try {
    const { fileId } = req.params;
    if (!/^[0-9a-f-]{36}$/.test(fileId)) return res.status(400).send('ID inválido');
    
    const filePath = `/tmp/${fileId}.mp3`;
    if (!fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado o expirado');
    
    const title = req.query.title ? decodeURIComponent(req.query.title) : 'audio';
    const safeName = title.replace(/[\/\\:*?"<>|]/g, '').trim() || 'audio';
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="audio.mp3"; filename*=UTF-8''${encodeURIComponent(safeName)}.mp3`);
    
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(filePath, () => {}));
    stream.on('error', () => fs.unlink(filePath, () => {}));
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error('[express error]', err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

app.listen(PORT, () => console.log(`VidToMP3 corriendo en puerto ${PORT}`));
