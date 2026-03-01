const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public')); // sirve el frontend

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Sanitize URL
function isValidUrl(url) {
  try { new URL(url); return true; } catch { return false; }
}

// POST /convert
app.post('/convert', (req, res) => {
  const { url, quality = '192' } = req.body;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'URL inválida' });
  }

  const allowedQualities = ['128', '192', '320'];
  const q = allowedQualities.includes(quality) ? quality : '192';

  const tmpDir = os.tmpdir();
  const fileId = uuidv4();
  const outPath = path.join(tmpDir, `${fileId}.mp3`);

  // yt-dlp command: extract audio as mp3
  const cmd = [
    'yt-dlp',
    '--no-playlist',
    '-x',
    '--audio-format mp3',
    `--audio-quality ${q}k`,
    '--no-warnings',
    '--no-progress',
    `--output "${outPath}"`,
    `"${url}"`
  ].join(' ');

  console.log(`[convert] ${url} @ ${q}kbps`);

  exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[yt-dlp error]', stderr);
      return res.status(500).json({ error: 'No se pudo convertir el video. Verifica el enlace.' });
    }

    if (!fs.existsSync(outPath)) {
      return res.status(500).json({ error: 'El archivo no se generó correctamente.' });
    }

    // Stream the file to the client
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="audio_${fileId}.mp3"`);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);

    // Cleanup after send
    stream.on('end', () => {
      fs.unlink(outPath, () => {});
    });
    stream.on('error', () => {
      fs.unlink(outPath, () => {});
    });
  });
});

app.listen(PORT, () => console.log(`VidToMP3 corriendo en puerto ${PORT}`));
