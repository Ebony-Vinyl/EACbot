export function wavDuration(audio: Uint8Array): number | null {
  const bytes = Buffer.from(audio);
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  )
    return null;
  let byteRate = 0;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) return null;
    const kind = bytes.toString("ascii", offset, offset + 4);
    if (kind === "fmt " && size >= 16) byteRate = bytes.readUInt32LE(start + 8);
    if (kind === "data") dataBytes += size;
    offset = start + size + (size % 2);
  }
  return byteRate > 0 ? dataBytes / byteRate : null;
}
