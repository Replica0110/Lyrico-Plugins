import fs from 'node:fs';
import path from 'node:path';
import { collectFiles, toPosixPath } from './fs-utils.js';

const CRC_TABLE = makeCrcTable();

export async function writeZipFromDirectory(root, outputPath, options = {}) {
  const excluded = new Set(options.exclude ?? ['.git', 'node_modules', 'dist', '.DS_Store']);
  const files = await collectFiles(root, { excluded });
  const records = [];
  const chunks = [];
  let offset = 0;

  for (const file of files) {
    const relative = toPosixPath(path.relative(root, file));
    const name = `${path.basename(root)}/${relative}`;
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = await fs.promises.readFile(file);
    const crc = crc32(data);
    const dos = dosDateTime(new Date((await fs.promises.stat(file)).mtime));

    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dos.time, 10);
    local.writeUInt16LE(dos.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);

    chunks.push(local, data);
    records.push({ nameBuffer, crc, size: data.length, offset, dos });
    offset += local.length + data.length;
  }

  const centralChunks = [];
  let centralSize = 0;
  for (const record of records) {
    const central = Buffer.alloc(46 + record.nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(record.dos.time, 12);
    central.writeUInt16LE(record.dos.date, 14);
    central.writeUInt32LE(record.crc, 16);
    central.writeUInt32LE(record.size, 20);
    central.writeUInt32LE(record.size, 24);
    central.writeUInt16LE(record.nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(record.offset, 42);
    record.nameBuffer.copy(central, 46);
    centralChunks.push(central);
    centralSize += central.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, Buffer.concat([...chunks, ...centralChunks, end]));
  return { outputPath, entries: records.length };
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
