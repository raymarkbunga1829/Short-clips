# Short-clips

Type a topic on your phone. Get a 9:16 mp4 with a spoken voiceover and burned-in
captions, ready to upload to YouTube Shorts or TikTok.

It runs as a single Next.js app on Vercel. No app to install, no Python on a
laptop, and no API keys — the voice and the video both come from free tooling.

---

## What you get

- **1080 × 1920, H.264 + AAC**, 15–30 seconds, playable inline on iOS and Android.
- **A real voiceover** from Microsoft Edge's free read-aloud voices, six to choose from.
- **Word-by-word captions** burned into the video, with the word being spoken highlighted.
- **An animated gradient background**, a title card and a progress bar, so it reads
  as a Short rather than a screen recording.

Everything is generated per request and streamed straight back to the browser.
Nothing is stored on a server.

## Deploy it

1. Push this repository to GitHub.
2. In Vercel, **Add New → Project**, import the repository, and deploy. The
   defaults are correct: Vercel detects Next.js, and `vercel.json` asks for the
   longer function timeout that rendering needs.
3. Open the deployment URL on your phone.

No environment variables are required.

### Optional: better scripts from an LLM

Without a key, scripts come from a built-in writer: it picks one of several
structures (hook → beats → close) and fills in your topic. The result is
coherent and correctly paced, but it is generic — it cannot say anything
specific about your subject.

Add an API key in **Vercel → Project → Settings → Environment Variables** and
scripts get written about the actual topic instead:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Enables model-written scripts. Nothing else is needed. |
| `OPENAI_BASE_URL` | Point at any OpenAI-compatible API. Defaults to `https://api.openai.com/v1`. |
| `OPENAI_MODEL` | Defaults to `gpt-4o-mini`. |

If the model is slow, unreachable or returns something unusable, the request
quietly falls back to the built-in writer, so a clip is always produced.

## Use it from your phone

Open the site, type a topic, pick a length and a voice, and press **Generate
clip**. When it finishes you get a player plus two buttons:

- **Save** downloads the mp4 to your device.
- **Share** opens the native share sheet (iOS and Android), which is the quickest
  route into Photos, TikTok or the YouTube app.

A 15 second clip normally takes 20–60 seconds to come back. Most of that is the
video encode.

## Trigger a clip from a bot

The same endpoint answers a plain `GET` and returns the mp4 as the response
body, so anything that can make an HTTP request can make a clip:

```bash
curl -L -o short.mp4 "https://<your-app>.vercel.app/api/generate?topic=Why+small+habits+compound"
```

Or `POST` JSON:

```bash
curl -L -o short.mp4 -X POST "https://<your-app>.vercel.app/api/generate" \
  -H 'Content-Type: application/json' \
  -d '{"topic":"Why small habits compound","seconds":15,"voice":"en-US-AndrewNeural"}'
```

| Parameter | Default | Notes |
| --- | --- | --- |
| `topic` | required | Up to 120 characters. |
| `seconds` | `16` | Target length, clamped to 10–30. The finished clip lands near this. |
| `voice` | `en-US-AriaNeural` | Any of the voices in `lib/options.ts`. |
| `palette` | picked from the topic | `midnight`, `ember`, `mint`, `grape`, `ocean`, `rose`. |
| `download` | `inline` | `download=1` sets a download disposition instead. |

The response carries the video, plus the script and timing as headers:
`X-Clip-Duration`, `X-Clip-Voice-Engine`, `X-Clip-Script-Source`, and
`X-Clip-Summary` (base64 JSON). Errors come back as JSON with an `error` field.

Requests are throttled to 6 per minute per IP, best effort.

## How it works

```
topic ─► script ─► voice ─► captions ─► one ffmpeg pass ─► mp4
```

1. **Script** (`lib/script.ts`) turns the topic into 3–6 spoken lines, sized to a
   word budget derived from the requested length. An LLM writes it when a key is
   configured; otherwise the built-in writer does.
2. **Voice** (`lib/edge-tts.ts`, `lib/voice.ts`) synthesises each line over a
   single WebSocket to Microsoft's read-aloud service, which returns mp3 audio
   *and* the start and duration of every word. Each line is trimmed back to its
   speech, which tightens the pacing and makes the finished length predictable.
3. **Captions** (`lib/captions.ts`) group those words into chunks of at most
   three and write an ASS subtitle file, one event per word so the spoken word
   can be highlighted.
4. **Render** (`lib/render.ts`) runs a single ffmpeg command: an animated
   gradient background, the narration clips concatenated with silences between
   them, the captions burned in with libass, and an H.264 mp4 out.

The whole thing runs inside one request in a temporary directory, which is what
lets it live in a single serverless function.

### Notes on running this on Vercel

- ffmpeg is not available on Vercel, so the `ffmpeg-static` binary is bundled and
  listed in `outputFileTracingIncludes`. Files uploaded with a function do not
  always keep their executable bit, so it is repaired at runtime.
- Serverless containers ship with no fonts. The caption font is committed to
  `assets/fonts/` and libass is pointed at it with `fontsdir`.
- Buffered function responses are capped at 4.5 MB, so the mp4 is streamed.
- Rendering is well inside the 300 second limit that Hobby projects allow.

## Running it locally

Node 20 or newer. ffmpeg is **not** required — it comes from `ffmpeg-static`.

```bash
npm install
npm run dev        # http://localhost:3000
```

```bash
npm test           # unit tests for the script, caption and render logic
npm run typecheck
npm run build
```

Set `SHORTCLIPS_FFMPEG_PATH` to use your own ffmpeg build instead of the
bundled one.

## Limitations

This is a first version, and it is deliberately small.

- Backgrounds are generated gradients. There is no stock footage and no image
  upload yet.
- English voices only, and the caption font covers Latin characters.
- Clips are not stored anywhere. Closing the tab before saving loses the clip.
- Nothing is published automatically; you upload the file yourself.

## Licence and credits

MIT, see [LICENSE](LICENSE).

The caption font is [Anton](https://fonts.google.com/specimen/Anton) by the Anton
Project Authors, used under the SIL Open Font License
(`assets/fonts/OFL.txt`). Voices come from Microsoft Edge's public read-aloud
service. The pipeline is written from scratch for this project.
