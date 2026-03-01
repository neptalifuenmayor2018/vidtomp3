const express = require('express');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ffmpegPath = require('ffmpeg-static');
const YTDlpWrap = require('yt-dlp-wrap').default;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const YT_DLP_BIN = path.join(__dirname, 'yt-dlp-bin');

// Crear symlink python3 -> python si no existe
function ensurePython() {
  const locations = ['/usr/bin/python3', '/usr/local/bin/python3', '/usr/bin/python'];
  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      console.log(`[init] python encontrado en: ${loc}`);
      // Crear symlink si python3 no existe pero python sí
      if (!fs.existsSync('/usr/local/bin/python3') && loc.includes('python') && !loc.includes('python3')) {
        try {
          execSync(`ln -sf ${loc} /usr/local/bin/python3`);
          console.log('[init] symlink python3 creado');
        } catch(e) {}
      }
      return loc;
    }
  }
  // Intentar instalar miniconda/python via mise o cualquier gestor disponible
  console.log('[init] Intentando instalar python...');
  try {
    execSync('mise install python@3.11', { stdio: 'inherit', timeout: 120000 });
    console.log('[init] python instalado via mise');
    return 'python3';
  } catch(e) {
    console.error('[init] No se pudo instalar python:', e.message);
  }
  return null;
}

async function ensureYtDlp() {
  if (fs.existsSync(YT_DLP_BIN)) {
    console.log('[init] yt-dlp ya existe');
    return;
  }
  console.log('[init] Descargando yt-dlp...');
  await YTDlpWrap.downloadFromGithub(YT_DLP_BIN);
  fs.chmodSync(YT_DLP_BIN, '755');
  console.log('[init] yt-dlp OK');
}

// yt-dlp tiene versión standalone que NO necesita python
// Forzamos descarga del binario standalone
async function downloadStandaloneYtDlp() {
  const https = require('https');
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
  console.log('[init] Descargando yt-dlp standalone (sin python)...');
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(YT_DLP_BIN);
    https.get(url, res => {
      // Seguir redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        https.get(res.headers.location, res2 => {
          res2.pipe(file);
          file.on('finish', () => {
            file.close();
            fs.chmodSync(YT_DLP_BIN, '755');
            console.log('[init] yt-dlp standalone descargado OK');
            resolve();
          });
        }).on('error', reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        fs.chmodSync(YT_DLP_BIN, '755');
        console.log('[init] yt-dlp standalone descargado OK');
        resolve();
      });
    }).on('error', e => {
      fs.unlink(YT_DLP_BIN, () => {});
      reject(e);
    });
  });
}

console.log('[init] ffmpeg:', ffmpegPath);
ensurePython();

// Descargar yt-dlp standalone al iniciar
if (fs.existsSync(YT_DLP_BIN)) {
  console.log('[init] yt-dlp ya existe, omitiendo descarga');
} else {
  downloadStandaloneYtDlp().catch(e => console.error('[init] Error:', e.message));
}

function isValidUrl(url) {
  try { new URL(url); return true; } catch { return false; }
}

app.post('/convert', async (req, res) => {
  const { url, quality = '192' } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'URL inválida' });

  const q = ['128','192','320'].includes(quality) ? quality : '192';
  const tmpDir = os.tmpdir();
  const fileId = uuidv4();
  const outTemplate = path.join(tmpDir, `${fileId}.%(ext)s`);
  const outPath = path.join(tmpDir, `${fileId}.mp3`);

  if (!fs.existsSync(YT_DLP_BIN)) {
    try { await downloadStandaloneYtDlp(); }
    catch(e) { return res.status(500).json({ error: 'yt-dlp no disponible, intenta en 30 segundos.' }); }
  }

  const cmd = [
    `"${YT_DLP_BIN}"`,
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

    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(fileId));
    const mp3 = files.find(f => f.endsWith('.mp3'));
    const finalPath = mp3 ? path.join(tmpDir, mp3) : outPath;

    if (!fs.existsSync(finalPath)) {
      return res.status(500).json({ error: 'Archivo no generado.', detail: files.join(', ') || 'ninguno' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="audio_${fileId}.mp3"`);
    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(finalPath, () => {}));
    stream.on('error', () => fs.unlink(finalPath, () => {}));
  });
});

app.listen(PORT, () => console.log(`VidToMP3 corriendo en puerto ${PORT}`));
