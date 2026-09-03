# Features, and how they compare to paid Loom

An honest map of what MyLoom does, what it does differently, and what it does
not do at all. Loom's paid tiers (Business / Business + AI) are the reference.

## Recording

| Loom paid | MyLoom | Notes |
|---|---|---|
| Screen, camera, or screen + camera | ✅ | Camera bubble is composited into a single track, draggable and resizable |
| Unlimited recording length | ✅ | Chunks upload during recording, so length is bounded by your disk, not memory |
| Unlimited number of videos | ✅ | No per-account caps anywhere in the code |
| HD / 1080p recording | ✅ | Capped at 1080p by default; raise it in `assets/js/recorder.js` (`sizeCanvas`) |
| Mic + system/tab audio | ✅ | Mixed through WebAudio. Tab audio needs Chrome or Edge |
| Pause and resume | ✅ | |
| Countdown before recording | ✅ | 3-2-1, can be turned off |
| Drawing / annotation while recording | ✅ | Five pen colours, strokes are burned into the video |
| Recording from a desktop app | ❌ | Browser only — there is no native app to install |
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

## Transcription and AI

| Loom paid | MyLoom | Notes |
|---|---|---|
| Automatic transcription | ⚠️ | Captured live in the browser via the Web Speech API — Chrome and Edge only, and less accurate than Loom's server-side model |
| Closed captions | ✅ | Rendered in the player and downloadable as WebVTT |
| Transcript search | ✅ | Inside a video, and across the whole library |
| Paste / import a transcript | ✅ | With or without timestamps |
| AI titles, summaries and chapters | ✅ | Uses any OpenAI-compatible endpoint if you supply a key; otherwise a built-in offline summariser runs with no external calls |
| Translated captions | ❌ | Not implemented |

## Editing

| Loom paid | MyLoom | Notes |
|---|---|---|
| Trim start and end | ✅ | Stored as playback boundaries, so it is non-destructive and reversible |
| Chapters | ✅ | Manual, or generated from a transcript |
| Stitch several videos together | ❌ | Needs re-encoding |
| Cut a section from the middle | ❌ | Same reason |

Trimming does not re-encode. Shared hosting rarely has `ffmpeg`, and running it
would block a PHP request for minutes. Boundaries are applied by the player, the
embed and the share page instead — the trade-off is that a downloaded file is
still the full recording.

## Teams

| Loom paid | MyLoom | Notes |
|---|---|---|
| Workspaces | ✅ | Unlimited, switchable |
| Spaces / folders | ✅ | Colour-coded, with counts |
| Roles and permissions | ✅ | Owner, admin, member, viewer |
| Email invitations | ✅ | With a copyable link if mail is not configured |
| Custom branding | ✅ | Logo, accent colour, and the "Powered by" line can be removed |
| Storage per workspace | ✅ | Tracked and displayed |
| Video library search and filters | ✅ | Mine / shared / starred, sort, bulk move and delete |
| Trash with restore | ✅ | |
| Loom Record button in Slack, Gmail, Jira | ❌ | No third-party integrations |
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
   Edge or Safari if your audience is on iOS.
3. **Live transcription is Chrome/Edge only** and noticeably rougher than a
   server-side model. You can always paste a better transcript in afterwards.
4. **Seeking a long WebM recording can be imprecise.** MediaRecorder does not
   write a seek index; the player works around it, but MP4 recordings behave
   better.
5. **No background jobs.** Everything happens in the request that triggers it,
   which is what keeps it deployable on shared hosting without cron or workers.
