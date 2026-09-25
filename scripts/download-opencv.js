const https = require('https');
const fs = require('fs');
const path = require('path');

// Use the latest 4.x build URL (always points to current stable)
const url = 'https://docs.opencv.org/4.x/opencv.js';
const destDir = path.join(__dirname, '..', 'public', 'opencv');
const dest = path.join(destDir, 'opencv.js');

if (fs.existsSync(dest)) {
  console.log('opencv.js already exists, skipping download.');
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });

console.log('Downloading OpenCV.js (4.x)...');

function download(downloadUrl, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    https.get(downloadUrl, (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(destination);
        download(response.headers.location, destination).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destination);
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }
      const total = parseInt(response.headers['content-length'] || '0', 10);
      let downloaded = 0;
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const pct = Math.round((downloaded / total) * 100);
          process.stdout.write(`\r  ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
        }
      });
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('\n  Done.');
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      fs.unlinkSync(destination);
      reject(err);
    });
  });
}

download(url, dest).catch((err) => {
  console.error('Failed to download OpenCV.js:', err.message);
  console.error('You can manually download it from:');
  console.error(`  ${url}`);
  console.error(`and place it at: ${dest}`);
  process.exit(1);
});
