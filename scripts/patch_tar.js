const fs = require('fs');
const path = require('path');

try {
  const rootDir = path.resolve(__dirname, '..');
  const tarDir = path.join(rootDir, 'node_modules', 'tar');
  if (!fs.existsSync(tarDir)) {
      console.log('tar package not found in node_modules, skipping patch.');
      process.exit(0);
  }

  // Dist CommonJS
  const cjsUnpackPath = path.join(tarDir, 'dist', 'commonjs', 'unpack.js');
  if (fs.existsSync(cjsUnpackPath)) {
      let content = fs.readFileSync(cjsUnpackPath, 'utf8');
      if (!content.includes('hardlink outside extraction directory')) {
          console.log('Applying patch to tar commonjs...');
          // Break hardlink
          fs.unlinkSync(cjsUnpackPath);

          content = content.replace(
            `const linkpath = (0, normalize_windows_path_js_1.normalizeWindowsPath)(node_path_1.default.resolve(this.cwd, String(entry.linkpath)));`,
            `const linkpath = (0, normalize_windows_path_js_1.normalizeWindowsPath)(node_path_1.default.resolve(this.cwd, String(entry.linkpath)));
        // Security check: ensure hardlink target is within CWD
        const rel = node_path_1.default.relative(this.cwd, linkpath);
        const isWithin = !rel.startsWith('..') && !node_path_1.default.isAbsolute(rel);
        if (!isWithin) {
            const er = Object.assign(new Error('TAR_ENTRY_ERROR: hardlink outside extraction directory'), {
                entry,
                linkpath: String(entry.linkpath),
                resolvedPath: linkpath,
                cwd: this.cwd,
                code: 'TAR_ENTRY_ERROR',
            });
            this[ONERROR](er, entry);
            return done();
        }`
          );
          fs.writeFileSync(cjsUnpackPath, content, 'utf8');
      }
  }

  // Dist ESM
  const esmUnpackPath = path.join(tarDir, 'dist', 'esm', 'unpack.js');
  if (fs.existsSync(esmUnpackPath)) {
      let content = fs.readFileSync(esmUnpackPath, 'utf8');
      if (!content.includes('hardlink outside extraction directory')) {
          console.log('Applying patch to tar esm...');
          // Break hardlink
          fs.unlinkSync(esmUnpackPath);

          content = content.replace(
            `const linkpath = normalizeWindowsPath(path.resolve(this.cwd, String(entry.linkpath)));`,
            `const linkpath = normalizeWindowsPath(path.resolve(this.cwd, String(entry.linkpath)));
        // Security check: ensure hardlink target is within CWD
        const rel = path.relative(this.cwd, linkpath);
        const isWithin = !rel.startsWith('..') && !path.isAbsolute(rel);
        if (!isWithin) {
            const er = Object.assign(new Error('TAR_ENTRY_ERROR: hardlink outside extraction directory'), {
                entry,
                linkpath: String(entry.linkpath),
                resolvedPath: linkpath,
                cwd: this.cwd,
                code: 'TAR_ENTRY_ERROR',
            });
            this[ONERROR](er, entry);
            return done();
        }`
          );
          fs.writeFileSync(esmUnpackPath, content, 'utf8');
      }
  }

  // Package JSON (change index.min.js to index.js)
  const pkgJsonPath = path.join(tarDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
      let content = fs.readFileSync(pkgJsonPath, 'utf8');
      if (content.includes('index.min.js')) {
          console.log('Applying patch to tar package.json...');
          // Break hardlink
          fs.unlinkSync(pkgJsonPath);

          content = content.replace(/\.\/dist\/esm\/index\.min\.js/g, './dist/esm/index.js');
          content = content.replace(/\.\/dist\/commonjs\/index\.min\.js/g, './dist/commonjs/index.js');

          fs.writeFileSync(pkgJsonPath, content, 'utf8');
      }
  }

  console.log('tar patch process completed.');

} catch (e) {
  console.log('Failed to patch tar', e.message);
  process.exit(1);
}
