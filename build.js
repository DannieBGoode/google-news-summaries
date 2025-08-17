const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');

const target = process.argv[2];
if (!['chrome', 'firefox'].includes(target)) {
  console.error('Usage: node build.js <chrome|firefox>');
  process.exit(1);
}

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist', target);
const MANIFEST_SRC = path.join(ROOT, `manifest.${target}.json`);
const MANIFEST_DEST = path.join(DIST, 'manifest.json');
const ZIP_PATH = path.join(ROOT, `${target}-extension.zip`);

// List of files/folders to include in the build
const INCLUDE = [
  'src',
  'options',
  'README.md',
  'popup.html',
  'popup.js',
  'icons', // optional
];

async function build() {
  // Clean dist and zip
  await fs.remove(DIST);
  await fs.remove(ZIP_PATH);
  await fs.ensureDir(DIST);

  // Copy only included files/folders
  for (const item of INCLUDE) {
    const srcPath = path.join(ROOT, item);
    if (await fs.pathExists(srcPath)) {
      await fs.copy(srcPath, path.join(DIST, item));
    } else {
      // Only warn for icons, popup.html, popup.js
      if (['icons', 'popup.html', 'popup.js'].includes(item)) {
        console.warn(`Warning: ${item} not found, skipping.`);
      } else {
        console.error(`Error: Required file or folder '${item}' not found.`);
        process.exit(1);
      }
    }
  }

  // Overwrite manifest
  await fs.copy(MANIFEST_SRC, MANIFEST_DEST, { overwrite: true });

  // Zip
  await zipDir(DIST, ZIP_PATH);
  console.log(`\n${target} build complete!`);
  console.log(`- Directory: ${DIST}`);
  console.log(`- Zip: ${ZIP_PATH}`);
}

function zipDir(srcDir, zipFile) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

build().catch(e => {
  console.error(e);
  process.exit(1);
});
