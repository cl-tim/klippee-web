function zipCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const crcTable = zipCrcTable();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function appendUint16(output: number[], value: number) {
  output.push(value & 0xff, (value >>> 8) & 0xff);
}

function appendUint32(output: number[], value: number) {
  output.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concatBytes(chunks: Uint8Array[]) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function createZip(files: Array<{ content: string; path: string }>) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  const { dosDate, dosTime } = zipDateTime(new Date());
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const contentBytes = encoder.encode(file.content);
    const checksum = crc32(contentBytes);
    const localHeader: number[] = [];

    appendUint32(localHeader, 0x04034b50);
    appendUint16(localHeader, 20);
    appendUint16(localHeader, 0);
    appendUint16(localHeader, 0);
    appendUint16(localHeader, dosTime);
    appendUint16(localHeader, dosDate);
    appendUint32(localHeader, checksum);
    appendUint32(localHeader, contentBytes.length);
    appendUint32(localHeader, contentBytes.length);
    appendUint16(localHeader, nameBytes.length);
    appendUint16(localHeader, 0);

    const localChunk = concatBytes([new Uint8Array(localHeader), nameBytes, contentBytes]);
    chunks.push(localChunk);

    const centralHeader: number[] = [];
    appendUint32(centralHeader, 0x02014b50);
    appendUint16(centralHeader, 20);
    appendUint16(centralHeader, 20);
    appendUint16(centralHeader, 0);
    appendUint16(centralHeader, 0);
    appendUint16(centralHeader, dosTime);
    appendUint16(centralHeader, dosDate);
    appendUint32(centralHeader, checksum);
    appendUint32(centralHeader, contentBytes.length);
    appendUint32(centralHeader, contentBytes.length);
    appendUint16(centralHeader, nameBytes.length);
    appendUint16(centralHeader, 0);
    appendUint16(centralHeader, 0);
    appendUint16(centralHeader, 0);
    appendUint16(centralHeader, 0);
    appendUint32(centralHeader, 0);
    appendUint32(centralHeader, offset);
    centralChunks.push(concatBytes([new Uint8Array(centralHeader), nameBytes]));

    offset += localChunk.length;
  }

  const centralDirectory = concatBytes(centralChunks);
  const endOfCentralDirectory: number[] = [];
  appendUint32(endOfCentralDirectory, 0x06054b50);
  appendUint16(endOfCentralDirectory, 0);
  appendUint16(endOfCentralDirectory, 0);
  appendUint16(endOfCentralDirectory, files.length);
  appendUint16(endOfCentralDirectory, files.length);
  appendUint32(endOfCentralDirectory, centralDirectory.length);
  appendUint32(endOfCentralDirectory, offset);
  appendUint16(endOfCentralDirectory, 0);

  return concatBytes([...chunks, centralDirectory, new Uint8Array(endOfCentralDirectory)]);
}
