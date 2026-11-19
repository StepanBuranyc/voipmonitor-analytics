import { InputError } from "./cdr.mjs";

export function readWave(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = () => {
    throw new InputError("Použijte WAV s 16bitovým PCM, jedním nebo dvěma kanály a frekvencí 8–48 kHz.");
  };
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") fail();
  const limit = buffer.readUInt32LE(4) + 8;
  if (limit > buffer.length || limit < 44) fail();
  let format;
  let data;
  for (let offset = 12; offset + 8 <= limit;) {
    const name = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > limit) fail();
    if (name === "fmt " && length >= 16 && !format) {
      const formatTag = buffer.readUInt16LE(start);
      const extensiblePcm = formatTag === 0xfffe && length >= 40 &&
        buffer.subarray(start + 24, start + 40).toString("hex") === "0100000000001000800000aa00389b71";
      const channels = buffer.readUInt16LE(start + 2);
      const rate = buffer.readUInt32LE(start + 4);
      const bits = buffer.readUInt16LE(start + 14);
      if ((formatTag !== 1 && !extensiblePcm) || (channels !== 1 && channels !== 2) ||
          bits !== 16 || rate < 8_000 || rate > 48_000 || buffer.readUInt16LE(start + 12) !== channels * 2) fail();
      format = { channels, rate };
    }
    if (name === "data" && !data) data = buffer.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  if (!format || !data?.length || data.length % (format.channels * 2)) fail();
  const frames = data.length / (format.channels * 2);
  if (frames / format.rate > 3_600) throw new InputError("Jedna nahrávka může mít nejvýše 60 minut.");
  return { ...format, data, frames };
}

export function writeWave(data, rate = 16_000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(data.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function toWhisperWave(bytes) {
  const { channels, rate, data, frames } = readWave(bytes);
  if (channels === 1 && rate === 16_000) return writeWave(data);
  const sample = (frame) => {
    const offset = frame * channels * 2;
    const first = data.readInt16LE(offset);
    return channels === 1 ? first : (first + data.readInt16LE(offset + 2)) / 2;
  };
  const step = rate / 16_000;
  const length = Math.max(1, Math.round(frames / step));
  const mono = Buffer.allocUnsafe(length * 2);
  for (let index = 0; index < length; index += 1) {
    const position = Math.min(index * step, frames - 1);
    const left = Math.floor(position);
    let value;
    if (step <= 1) {
      const fraction = position - left;
      value = (1 - fraction) * sample(left) + fraction * sample(Math.min(left + 1, frames - 1));
    } else {
      const right = Math.min(frames, Math.floor((index + 1) * step));
      let sum = 0;
      for (let source = left; source < right; source += 1) sum += sample(source);
      value = right > left ? sum / (right - left) : sample(left);
    }
    mono.writeInt16LE(Math.round(value), index * 2);
  }
  return writeWave(mono);
}
