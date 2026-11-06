const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

async function saveItemImage(file, itemType) {
  const buffer = file.buffer;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  const extension = isJpeg ? 'jpg' : isPng ? 'png' : isWebp ? 'webp' : null;
  if (!extension) {
    const error = new Error('Upload a valid JPG, PNG, or WEBP image.');
    error.status = 400;
    throw error;
  }
  const filename = `${randomUUID()}.${extension}`;
  const found = itemType === 'found';
  const directory = found
    ? path.resolve(__dirname, '..', '..', 'private_uploads', 'found')
    : path.resolve(__dirname, '..', '..', 'uploads', 'lost');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, filename), buffer, { flag: 'wx' });
  return found ? filename : `uploads/lost/${filename}`;
}

module.exports = { saveItemImage };
