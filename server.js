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

// Instalar yt-dlp y ffmpeg al arrancar si no están disponibles
function ensureDeps() {
  // Intentar encontrar yt-dlp
  try {
    const ver = execSync('yt-dlp --version', {timeout:5000}).toString().trim();
    console.log(`[init] yt-dlp OK: ${ver}`);
  } catch {
    console.log('[init] yt-dlp no encontrado, instalando...');
    try {
      execSync('pip3 install -U yt-dlp', {stdio:'inherit', timeout:60000});
      console.log('[init] yt-dlp instalado OK');
    } catch(e) {
      console.error('[init] Error instalando yt-dlp:', e.message);
    }
  }

  // Verificar ffmpeg
  try {
    execSync('ffmpeg -version', {timeout:5000});
    console.log('[init] ffmpeg OK');
  } catch {
    console.log('[init] ffmpeg no encontrado, instalando...');
    try {
      execSync('apt-get install -y ffmpeg', {stdio:'inherit', timeout:120000});
      console.log('[init] ffmpeg instalado OK');
    } catch(e) {
      console.error('[init] Error instalando ffmpeg:', e.message);
    }
  }
}

ensureDeps();

// Buscar ruta de yt-dlp
function getYtDlpPath() {
  const paths = [
    'yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    `${os.homedir()}/.local/bin/yt-dlp`,
    '/root/.local/bin/yt-dlp'
  ];
  for (const p of paths) {
    try { execSync(`${p} --version`, {timeout:3000}); return p; } catch {}
  }
  return 'yt-dlp';
}

function isValidUrl(url) {
  try { new URL(url); return true; } catch { return false; }
}

app.post('/convert', (req, res) => {
  const { url, quality = '192' } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'URL inválida' });

  const q = ['128','192','320'].includes(quality) ? quality : '192';
  const tmpDir = os.tmpdir();
  const fileId = uuidv4();
  const outTemplate = path.join(tmpDir, fileId);
  const ytDlp = getYtDlpPath();

  const cmd = [
    `"${ytDlp}"`,
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

  console.log(`[convert] ${url} @ ${q}kbps`);
  console.log(`[convert] CMD: ${cmd}`);

  exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
    console.log('[stdout]', stdout);
    console.log('[stderr]', stderr);

    if (err) {
      console.error('[error]', err.message);
      return res.status(500).json({ error: 'No se pudo convertir el video. Verifica el enlace.', detail: stderr });
    }

    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(fileId));
    const mp3 = files.find(f => f.endsWith('.mp3'));
    const finalPath = mp3 ? path.join(tmpDir, mp3) : null;

    if (!finalPath || !fs.existsSync(finalPath)) {
      return res.status(500).json({ error: 'El archivo MP3 no se generó.', detail: `Archivos: ${files.join(', ')||'ninguno'}` });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="audio_${fileId}.mp3"`);
    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(finalPath, ()=>{}));
    stream.on('error', () => fs.unlink(finalPath, ()=>{}));
  });
});

app.listen(PORT, () => console.log(`VidToMP3 corriendo en puerto ${PORT}`));
