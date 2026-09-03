# Features, and how they compare to paid Loom

An honest map of what MyLoom does, what it does differently, and what it does
not do at all. Loom's paid tiers (Business / Business + AI) are the reference.

## Recording

| Loom paid | MyLoom | Notes |
|---|---|---|
| Screen, tab, or camera, each with an optional camera bubble | ✅ | Same three modes in the web app and the extension; the bubble is composited into a single track, draggable and resizable |
| Unlimited recording length | ✅ | Chunks upload during recording, so length is bounded by your disk, not memory |
| Unlimited number of videos | ✅ | No per-account caps anywhere in the code |
| HD / 1080p recording | ✅ | Capped at 1080p by default; raise it in `assets/js/recorder.js` (`sizeCanvas`) |
| Mic + system/tab audio | ✅ | Mixed through WebAudio. Tab audio needs Chrome or Edge |
| Pause and resume | ✅ | |
| Countdown before recording | ✅ | 3-2-1, can be turned off |
| Drawing / annotation while recording | ✅ | Five pen colours, strokes are burned into the video |
| Recording from a desktop app | ❌ | Browser only — there is no native app to install |
| One-click record from a browser extension | ✅ | Chrome/Edge extension in `extension/`, with a floating control bar that follows you across tabs |
| Mobile recording | ❌ | Mobile browsers cannot capture the screen; watching works fine |
| Background blur / virtual background | ❌ | Needs an ML segmentation model; not implemented |
| Remove filler words and silences | ❌ | Would require server-side re-encoding (see *Editing* below) |

## Sharing and privacy

| Loom paid | MyLoom | Notes |
|---|---|---|
| Instant share link | ✅ | Created before recording finishes |
| Password-protected videos | ✅ | Per video and, separately, per share link |
| Link expiry dates | ✅ | Per video and per share link |
| Viewer email gate (lead capture) | ✅ | Captured names/emails appear in analytics and the CSV |
| Require viewers to sign in | ✅ | Only people with an account can watch; the media endpoint enforces it too |
| Disable downloads / comments | ✅ | Per video, and downloads can be disabled per link |
| Private / team / public visibility | ✅ | Plus "anyone with the link" |
| Custom thumbnails | ✅ | Upload an image or grab the current frame |
| Embed anywhere | ✅ | Responsive iframe snippet; `/embed/<id>` route |
| Link previews in Slack, iMessage, LinkedIn | ✅ | Open Graph and Twitter card tags are server-rendered |
| Per-recipient tracked links | ✅ | Each with its own label, password, expiry and view cap |
| Revoke a link | ✅ | |
| Custom domain | ⚠️ | Point any domain or subdomain at the install — that *is* the custom domain |
| SSO / SAML | ❌ | Email + password only |

## Analytics

| Loom paid | MyLoom | Notes |
|---|---|---|
| View counts and unique viewers | ✅ | De-duplicated per session |
| Who watched (named viewers) | ✅ | Signed-in users by name; guests via the email gate |
| Watch time and completion rate | ✅ | |
| Engagement / attention graph | ✅ | 100 buckets across the video, showing replays and drop-off |
| Views over time | ✅ | 30-day timeline |
| Devices and traffic sources | ✅ | Referrer and device class per view |
| CSV export | ✅ | |
| Workspace-wide dashboard | ✅ | |

## Engagement

| Loom paid | MyLoom | Notes |
|---|---|---|
| Timestamped comments | ✅ | Click a timestamp to jump there |
| Threaded replies | ✅ | One level deep |
| Emoji reactions | ✅ | On comments and on the timeline, floating over the player |
| Guest comments | ✅ | Name optional; no account needed |
| Resolve comments | ✅ | Owner only |
| Email + in-app notifications | ✅ | Per-event preferences per user |
| Call-to-action button | ✅ | Per video, with a workspace-wide default |
| CTA and link click tracking | ✅ | Clicks on the CTA banner and on-video links are counted per destination in analytics |

## Transcription and AI

| Loom paid | MyLoom | Notes |
|---|---|---|
| Automatic transcription | ✅ | **Transcribe with AI** sends the audio to any OpenAI-compatible speech-to-text endpoint (Whisper and friends) for proper accuracy. A rough live transcript from the browser's speech API is still captured while recording, as a no-key fallback |
| Closed captions | ✅ | Rendered in the player, downloadable as **WebVTT or SRT** |
| Edit captions | ✅ | Fix wording and timings line by line |
| Translated captions | ✅ | Creates a second track with the original timings; viewers pick the language in the player |
| Transcript search | ✅ | Inside a video, and across the whole library |
| Paste / import a transcript | ✅ | With or without timestamps |
| AI titles, summaries and chapters | ✅ | Uses any OpenAI-compatible endpoint if you supply a key; otherwise a built-in offline summariser runs with no external calls |

## Editing

| Loom paid | MyLoom | Notes |
|---|---|---|
| Trim start and end | ✅ | Stored as playback boundaries, so it is non-destructive and reversible |
| Chapters | ✅ | Manual, or generated from a transcript |
| Add text on the video | ✅ | Timed, positioned, sized, coloured, with an optional background |
| Add a clickable link / CTA button | ✅ | Real `<a>` on the share page and in embeds |
| Blur a region | ✅ | For a password, email or face — see the note below |
| Shapes: box, circle, arrow | ✅ | Colour and line thickness per shape |
| Show an overlay only for part of the video | ✅ | Every overlay has its own range, e.g. 1:11 → 2:30. Type the timecode, drag the bar on the timeline, or snap either end to the playhead |
| Burn edits into the file | ✅ | Re-encodes in your browser; also available as "apply permanently" |
| Cut a section from the middle | ✅ | Split anywhere, delete the pieces you do not want — playback skips straight over them |
| Reorder pieces of a recording | ✅ | Move pieces up and down; they play in the order you set |
| Remove silences automatically | ✅ | Analyses the audio in your browser and drops quiet stretches over 0.7s |
| Stitch several separate videos together | ❌ | Cutting and reordering works within one recording, not across several |

**How editing works here.** Cuts, trim and overlays are stored as metadata and drawn
by the player, so edits are instant and reversible, and nothing is re-encoded
on your server (shared hosting has no `ffmpeg`, and running it would block a PHP
request for minutes). When you need them to be part of the file itself — to
download a flattened copy, or to genuinely remove what a blur covers — MyLoom
re-encodes in the browser via canvas + MediaRecorder, either as a one-off
download or with **Apply overlays & trim permanently**, which replaces the
stored file.

> **Blur is cosmetic until you bake it in.** A blur drawn by the player hides
> the area on screen, but the original pixels are still in the video file, so a
> determined viewer could recover them. If you are hiding a password or personal
> data, use *Apply overlays & trim permanently* — that re-encodes the video and
> the covered pixels are gone. The editor says this wherever a blur is in use.

## Download formats

| Loom paid | MyLoom | Notes |
|---|---|---|
| Download MP4 | ⚠️ | Offered whenever your browser can encode H.264 (Chrome, Edge, Safari). Firefox can only produce WebM |
| Choose the download format | ✅ | Pick WebM or MP4 per download; the original is served untouched when it already matches |
| Choose the resolution | ✅ | Original, 1080p or 720p |

Conversion happens in your browser and runs in real time — a 10-minute video
takes about 10 minutes — so the dialog tells you the estimate before you start.
When you ask for the format the file is already in, with no overlays or trim to
apply, the original bytes are served instantly with no quality loss.

## Teams

| Loom paid | MyLoom | Notes |
|---|---|---|
| Workspaces | ✅ | Unlimited, switchable |
| Folders | ✅ | Colour-coded with video counts, in the sidebar and the library toolbar; rename, recolour, delete, and bulk-move videos in |
| Roles and permissions | ✅ | Owner, admin, member, viewer |
| Email invitations | ✅ | With a copyable link if mail is not configured |
| Custom branding | ✅ | Logo, accent colour, and the "Powered by" line can be removed |
| Watermark on every video | ✅ | Workspace logo or text, pinned to a corner — shown in the player and embeds, and burned in when you re-encode |
| Slack notifications | ✅ | An Incoming Webhook posts comments and views to a channel; no app install |
| Storage per workspace | ✅ | Tracked and displayed |
| Video library search and filters | ✅ | Mine / shared / starred, sort, bulk move and delete |
| Trash with restore | ✅ | |
| Animated preview on hover | ✅ | Hovering a card plays the real file muted — no GIF to generate or store |
| Loom Record button in Slack, Gmail, Jira | ❌ | Slack gets notifications, but there is no Record button inside Slack, Gmail or Jira |
| API tokens for other tools | ✅ | Create and revoke per-token in Settings → Profile; only the hash is stored |
| Salesforce / HubSpot sync | ❌ | |
| Enterprise admin controls, audit log | ❌ | There is a basic instance admin panel |

## Cost

Loom Business is priced per creator seat per month. MyLoom is your hosting bill:
one cPanel account, and disk space. As a rough guide, 1080p recording at the
default bitrate uses **about 20 MB per minute**, so 10 GB of hosting holds
roughly eight hours of video.

## Known limitations

1. **Recording needs a desktop browser over HTTPS.** Mobile browsers cannot
   capture a screen, and no browser allows capture on plain HTTP.
2. **WebM will not play on iPhones.** Chrome and Safari record H.264/MP4 where
   the machine supports it, and MyLoom prefers that automatically. Firefox can
   only produce WebM, which Apple devices refuse to play. Record in Chrome,
   Edge or Safari if your audience is on iOS — or convert an existing WebM to
   MP4 from the Download dialog.
3. **Good transcription needs an AI key.** With one, audio is extracted in your
   browser (16 kHz mono WAV, split into eight-minute pieces) and sent to your
   configured endpoint. Without one, you get the browser's live speech
   recognition, which is Chrome/Edge only and noticeably rougher — or you can
   paste a transcript in.
4. **Seeking a long WebM recording can be imprecise.** MediaRecorder does not
   write a seek index; the player works around it, but MP4 recordings behave
   better.
5. **Browser-side conversion is real time and needs the tab in the foreground.**
   Background tabs get throttled, which stalls the encoder. For very long
   videos, download the original instead.
6. **No background jobs.** Everything happens in the request that triggers it,
   which is what keeps it deployable on shared hosting without cron or workers.
