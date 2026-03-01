const express = require('express');
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Verificar yt-dlp al iniciar
try {
  const ver = execSync('yt-dlp --version').toString().trim();
  console.log(`[init] yt-dlp version: ${ver}`);
} catch(e) {
  console.error('[init] yt-dlp NO encontrado:', e.message);
}

// Verificar ffmpeg al iniciar
try {
  execSync('ffmpeg -version');
  console.log('[init] ffmpeg OK');
} catch(e) {
  console.error('[init] ffmpeg NO encontrado:', e.message);
}

function isValidUrl(url) {
  try { new URL(url); return true; } catch { return false; }
}

app.post('/convert', (req, res) => {
  const { url, quality = '192' } = req.body;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'URL inválida' });
  }

  const allowedQualities = ['128', '192', '320'];
  const q = allowedQualities.includes(quality) ? quality : '192';

  const tmpDir = os.tmpdir();
  const fileId = uuidv4();
  // yt-dlp agrega extensión solo, usamos template sin extensión
  const outTemplate = path.join(tmpDir, fileId);
  const outPath = outTemplate + '.mp3';

  const cmd = [
    'yt-dlp',
    '--no-playlist',
    '-x',
    '--audio-format mp3',
    `--audio-quality ${q}k`,
    '--no-warnings',
    '--no-progress',
    '--force-overwrites',
    `-o "${outTemplate}.%(ext)s"`,
    `"${url}"`
  ].join(' ');

  console.log(`[convert] CMD: ${cmd}`);

  exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
    console.log('[convert] stdout:', stdout);
    console.log('[convert] stderr:', stderr);

    if (err) {
      console.error('[convert] ERROR:', err.message);
      // Devolver error detallado al cliente para diagnosticar
      return res.status(500).json({
        error: 'No se pudo convertir el video.',
        detail: stderr || err.message
      });
    }

    // Buscar el archivo generado (puede ser .mp3 u otra ext convertida)
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(fileId));
    console.log('[convert] archivos generados:', files);

    const mp3File = files.find(f => f.endsWith('.mp3'));
    const finalPath = mp3File ? path.join(tmpDir, mp3File) : outPath;

    if (!fs.existsSync(finalPath)) {
      return res.status(500).json({
        error: 'El archivo MP3 no se generó.',
        detail: `Archivos encontrados: ${files.join(', ') || 'ninguno'}`
      });
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
