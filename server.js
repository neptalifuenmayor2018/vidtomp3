const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { execSync, exec } = require('child_process');
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

// Ruta donde se guarda el binario de yt-dlp
const YT_DLP_BIN = path.join(__dirname, 'yt-dlp-bin');

async function ensureYtDlp() {
  if (fs.existsSync(YT_DLP_BIN)) {
    console.log('[init] yt-dlp binario ya existe');
    return;
  }
  console.log('[init] Descargando yt-dlp...');
  await YTDlpWrap.downloadFromGithub(YT_DLP_BIN);
  fs.chmodSync(YT_DLP_BIN, '755');
  console.log('[init] yt-dlp descargado OK');
}

console.log('[init] ffmpeg path:', ffmpegPath);

ensureYtDlp().then(() => {
  console.log('[init] Todo listo');
}).catch(e => {
  console.error('[init] Error descargando yt-dlp:', e.message);
});

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

  // Asegurarse de que yt-dlp esté listo
  if (!fs.existsSync(YT_DLP_BIN)) {
    try {
      await YTDlpWrap.downloadFromGithub(YT_DLP_BIN);
      fs.chmodSync(YT_DLP_BIN, '755');
    } catch(e) {
      return res.status(500).json({ error: 'yt-dlp no disponible aún, intenta en 30 segundos.' });
    }
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
      return res.status(500).json({ error: 'No se pudo convertir el video. Verifica el enlace.', detail: stderr });
    }

    if (!fs.existsSync(outPath)) {
      // Buscar cualquier archivo generado
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(fileId));
      console.log('[convert] archivos:', files);
      const found = files.find(f => f.endsWith('.mp3'));
      if (!found) {
        return res.status(500).json({ error: 'Archivo no generado.', detail: files.join(', ') });
      }
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="audio_${fileId}.mp3"`);
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(outPath, () => {}));
    stream.on('error', () => fs.unlink(outPath, () => {}));
  });
});

app.listen(PORT, () => console.log(`VidToMP3 corriendo en puerto ${PORT}`));
