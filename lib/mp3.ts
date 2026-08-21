/**
 * Just enough MPEG audio parsing to measure an mp3 without shelling out to
 * ffprobe, which the serverless bundle does not ship.
 */

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

function id3Size(buffer: Buffer): number {
  if (buffer.length < 10 || buffer.toString("ascii", 0, 3) !== "ID3") return 0;
  // Four synchsafe bytes: seven significant bits each.
  const size =
    (buffer[6] & 0x7f) * 0x200000 +
    (buffer[7] & 0x7f) * 0x4000 +
    (buffer[8] & 0x7f) * 0x80 +
    (buffer[9] & 0x7f);
  return size + 10;
}

/** Duration in seconds, summed frame by frame so VBR files measure correctly. */
export function mp3Duration(buffer: Buffer): number {
  let offset = id3Size(buffer);
  let samples = 0;
  let sampleRate = 0;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }

    const versionBits = (buffer[offset + 1] >> 3) & 0x03;
    const layerBits = (buffer[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
    const rateIndex = (buffer[offset + 2] >> 2) & 0x03;
    const padding = (buffer[offset + 2] >> 1) & 0x01;

    const rates = SAMPLE_RATES[versionBits];
    // layerBits === 1 is Layer III; bitrate index 15 and rate index 3 are invalid.
    if (!rates || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      offset += 1;
      continue;
    }

    const isVersion1 = versionBits === 3;
    const bitrate = (isVersion1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex] * 1000;
    sampleRate = rates[rateIndex];
    const samplesPerFrame = isVersion1 ? 1152 : 576;
    const frameLength = Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
    if (frameLength <= 4) {
      offset += 1;
      continue;
    }

    samples += samplesPerFrame;
    offset += frameLength;
  }

  return sampleRate > 0 ? samples / sampleRate : 0;
}
