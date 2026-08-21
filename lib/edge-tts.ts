/**
 * Minimal client for Microsoft Edge's public "read aloud" speech service.
 *
 * Written from the wire protocol rather than ported from an existing library:
 * a WebSocket carries newline-delimited header blocks, text frames deliver JSON
 * metadata (including per-word timings) and binary frames deliver mp3 bytes.
 *
 * The service is free and needs no account, which is what makes the whole app
 * runnable without any API keys.
 */

import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR = CHROMIUM_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_VERSION}`;
const ENDPOINT =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

/** Seconds between the Windows file time epoch (1601-01-01) and the Unix epoch. */
const WINDOWS_EPOCH_OFFSET = 11_644_473_600;
const TICKS_PER_SECOND = 10_000_000n;
/** The service rounds its own clock to this bucket when checking the token. */
const TOKEN_BUCKET_SECONDS = 300;

const CONNECT_TIMEOUT_MS = 12_000;
const TURN_TIMEOUT_MS = 30_000;

export interface EdgeWord {
  text: string;
  /** Seconds from the start of this utterance. */
  offset: number;
  duration: number;
}

export interface EdgeSpeech {
  audio: Buffer;
  words: EdgeWord[];
}

export interface EdgeVoiceOptions {
  voice?: string;
  /** Prosody rate, e.g. "+8%". */
  rate?: string;
  pitch?: string;
  volume?: string;
}

/** Corrects for a local clock that disagrees with the service. */
let clockSkewSeconds = 0;

function securityToken(): string {
  const now = Math.floor(Date.now() / 1000 + clockSkewSeconds) + WINDOWS_EPOCH_OFFSET;
  const bucket = now - (now % TOKEN_BUCKET_SECONDS);
  const fileTime = BigInt(bucket) * TICKS_PER_SECOND;
  return createHash("sha256")
    .update(`${fileTime}${TRUSTED_CLIENT_TOKEN}`, "ascii")
    .digest("hex")
    .toUpperCase();
}

/** The service expects a JavaScript-style date string, not RFC 1123. */
function timestamp(): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ` +
    `${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:` +
    `${pad(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSsml(text: string, options: Required<EdgeVoiceOptions>): string {
  const lang = options.voice.split("-").slice(0, 2).join("-") || "en-US";
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${options.voice}'>` +
    `<prosody pitch='${options.pitch}' rate='${options.rate}' volume='${options.volume}'>` +
    `${escapeXml(text)}` +
    `</prosody></voice></speak>`
  );
}

/** Splits a "Key:Value\r\n...\r\n\r\nbody" frame into its headers and body. */
function parseFrame(message: string): { headers: Record<string, string>; body: string } {
  const split = message.indexOf("\r\n\r\n");
  const rawHeaders = split === -1 ? message : message.slice(0, split);
  const body = split === -1 ? "" : message.slice(split + 4);
  const headers: Record<string, string> = {};
  for (const line of rawHeaders.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { headers, body };
}

/**
 * Binary frames start with a big-endian uint16 giving the length of a text
 * header block; everything after that is raw audio.
 */
function audioFromBinaryFrame(frame: Buffer): Buffer | null {
  if (frame.length < 2) return null;
  const headerLength = frame.readUInt16BE(0);
  const start = 2 + headerLength;
  if (start >= frame.length) return null;
  const header = frame.subarray(2, start).toString("utf8");
  if (!/Path:\s*audio/i.test(header)) return null;
  return frame.subarray(start);
}

export class EdgeTtsError extends Error {}

/**
 * One connection, reused across lines. The service accepts several turns per
 * socket, which keeps the whole narration to a single handshake.
 */
export class EdgeTtsSession {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private readonly defaults: EdgeVoiceOptions;

  constructor(defaults: EdgeVoiceOptions = {}) {
    this.defaults = defaults;
  }

  async speak(text: string, options: EdgeVoiceOptions = {}): Promise<EdgeSpeech> {
    const merged: Required<EdgeVoiceOptions> = {
      voice: options.voice ?? this.defaults.voice ?? "en-US-AriaNeural",
      rate: options.rate ?? this.defaults.rate ?? "+0%",
      pitch: options.pitch ?? this.defaults.pitch ?? "+0Hz",
      volume: options.volume ?? this.defaults.volume ?? "+0%",
    };

    try {
      return await this.runTurn(text, merged);
    } catch (error) {
      // A dropped socket is common between turns; one clean retry covers it.
      this.dispose();
      if (error instanceof EdgeTtsError) throw error;
      return await this.runTurn(text, merged);
    }
  }

  private async runTurn(text: string, options: Required<EdgeVoiceOptions>): Promise<EdgeSpeech> {
    const socket = await this.connect();
    const requestId = randomUUID().replace(/-/g, "");

    return await new Promise<EdgeSpeech>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const words: EdgeWord[] = [];
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
        if (error) reject(error);
        else resolve({ audio: Buffer.concat(chunks), words });
      };

      const timer = setTimeout(
        () => finish(new Error("Timed out waiting for the speech service.")),
        TURN_TIMEOUT_MS,
      );

      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (isBinary) {
          const audio = audioFromBinaryFrame(frame);
          if (audio?.length) chunks.push(audio);
          return;
        }

        const { headers, body } = parseFrame(frame.toString("utf8"));
        if (headers["X-RequestId"] && headers["X-RequestId"] !== requestId) return;

        const path = headers["Path"];
        if (path === "audio.metadata") {
          for (const entry of parseMetadata(body)) words.push(entry);
        } else if (path === "turn.end") {
          finish();
        }
      };

      const onError = (error: Error) => finish(error);
      const onClose = () => finish(new Error("Speech service closed the connection early."));

      socket.on("message", onMessage);
      socket.once("error", onError);
      socket.once("close", onClose);

      try {
        socket.send(
          `X-Timestamp:${timestamp()}\r\n` +
            "Content-Type:application/json; charset=utf-8\r\n" +
            "Path:speech.config\r\n\r\n" +
            JSON.stringify({
              context: {
                synthesis: {
                  audio: {
                    metadataoptions: {
                      sentenceBoundaryEnabled: "false",
                      wordBoundaryEnabled: "true",
                    },
                    outputFormat: OUTPUT_FORMAT,
                  },
                },
              },
            }) +
            "\r\n",
        );
        socket.send(
          `X-RequestId:${requestId}\r\n` +
            "Content-Type:application/ssml+xml\r\n" +
            `X-Timestamp:${timestamp()}Z\r\n` +
            "Path:ssml\r\n\r\n" +
            buildSsml(text, options),
        );
      } catch (error) {
        finish(error as Error);
      }
    });
  }

  private connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = this.openSocket()
      .then((socket) => {
        this.socket = socket;
        this.connecting = null;
        socket.once("close", () => {
          if (this.socket === socket) this.socket = null;
        });
        return socket;
      })
      .catch((error) => {
        this.connecting = null;
        throw error;
      });

    return this.connecting;
  }

  private openSocket(retryOnSkew = true): Promise<WebSocket> {
    const url =
      `${ENDPOINT}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${securityToken()}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
      `&ConnectionId=${randomUUID().replace(/-/g, "")}`;

    const socket = new WebSocket(url, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      headers: {
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
          `Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
      },
    });

    return new Promise<WebSocket>((resolve, reject) => {
      socket.once("open", () => resolve(socket));
      socket.once("error", (error) => reject(error));
      socket.once("unexpected-response", (_request, response) => {
        socket.terminate();
        const serverDate = response.headers.date;
        // 401/403 usually means our token was built from a clock the service
        // disagrees with. Re-sync from the server's own Date header and retry.
        if (retryOnSkew && serverDate && (response.statusCode === 401 || response.statusCode === 403)) {
          const parsed = Date.parse(String(serverDate));
          if (!Number.isNaN(parsed)) {
            clockSkewSeconds += parsed / 1000 - Date.now() / 1000;
            this.openSocket(false).then(resolve, reject);
            return;
          }
        }
        reject(
          new EdgeTtsError(
            `Speech service refused the connection (HTTP ${response.statusCode ?? "?"}).`,
          ),
        );
      });
    });
  }

  dispose(): void {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.removeAllListeners();
      socket.terminate();
    }
  }
}

interface MetadataEntry {
  Type?: string;
  Data?: {
    Offset?: number;
    Duration?: number;
    text?: { Text?: string };
  };
}

function parseMetadata(body: string): EdgeWord[] {
  let payload: { Metadata?: MetadataEntry[] };
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }

  const words: EdgeWord[] = [];
  for (const entry of payload.Metadata ?? []) {
    if (entry.Type !== "WordBoundary") continue;
    const text = entry.Data?.text?.Text;
    if (!text) continue;
    words.push({
      text,
      // Timings arrive in 100-nanosecond ticks.
      offset: (entry.Data?.Offset ?? 0) / 1e7,
      duration: (entry.Data?.Duration ?? 0) / 1e7,
    });
  }
  return words;
}
