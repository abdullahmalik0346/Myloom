<?php
/**
 * Transcripts and captions.
 * Segments are captured in the browser during recording (Web Speech API) and
 * can optionally be refined by an OpenAI-compatible endpoint configured in
 * Settings → AI. A built-in extractive summariser runs when no key is set.
 */
final class TranscriptController
{
    public static function save(): void
    {
        $video = VideoController::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only edit your own videos.', 403);
        }

        $segments = Http::input('segments', []);
        if (!is_array($segments) || !$segments) {
            Http::fail('No transcript segments were supplied.');
        }

        $clean = [];
        $plain = [];
        foreach (array_slice($segments, 0, 5000) as $seg) {
            $text = trim((string)($seg['text'] ?? ''));
            if ($text === '') {
                continue;
            }
            $start = max(0, (float)($seg['start'] ?? 0));
            $end   = max($start, (float)($seg['end'] ?? $start + 3));
            $clean[] = ['start' => $start, 'end' => $end, 'text' => mb_substr($text, 0, 500)];
            $plain[] = $text;
        }
        if (!$clean) {
            Http::fail('The transcript was empty.');
        }

        $lang = mb_substr(Http::str('lang', 'en'), 0, 12);
        Db::run('DELETE FROM transcripts WHERE video_id = ? AND lang = ?', [(int)$video['id'], $lang]);
        // The first track stored becomes the default caption language.
        $isDefault = (int)Db::value('SELECT COUNT(*) FROM transcripts WHERE video_id = ?', [(int)$video['id']]) === 0
            ? 1 : 0;
        Db::insert('transcripts', [
            'video_id'   => (int)$video['id'],
            'lang'       => $lang,
            'label'      => mb_substr(Http::str('label', 'English'), 0, 60),
            'segments'   => json_encode($clean, JSON_UNESCAPED_UNICODE),
            'plain_text' => mb_substr(implode(' ', $plain), 0, 4000000),
            'source'     => in_array(Http::str('source', 'browser'), ['browser', 'api', 'manual'], true)
                ? Http::str('source', 'browser') : 'browser',
            'is_default' => $isDefault,
            'created_at' => Util::now(),
        ]);

        Http::ok(['segments' => count($clean)]);
    }

    public static function get(): void
    {
        [$video, $share] = WatchController::resolve();
        [$allowed] = Permissions::canWatch($video, $share);
        if (!$allowed) {
            Http::fail('Not allowed.', 403);
        }
        $lang = preg_replace('/[^A-Za-z-]/', '', Http::query('lang')) ?: '';
        $row = $lang !== ''
            ? Db::one('SELECT * FROM transcripts WHERE video_id = ? AND lang = ? LIMIT 1', [(int)$video['id'], $lang])
            : null;
        if (!$row) {
            $row = Db::one(
                'SELECT * FROM transcripts WHERE video_id = ? ORDER BY is_default DESC, id ASC LIMIT 1',
                [(int)$video['id']]
            );
        }
        if (!$row) {
            Http::ok(['transcript' => null]);
        }
        Http::ok(['transcript' => [
            'lang'     => $row['lang'],
            'label'    => $row['label'],
            'source'   => $row['source'],
            'segments' => json_decode((string)$row['segments'], true) ?: [],
            'text'     => $row['plain_text'],
        ]]);
    }

    /** GET /api/transcript/list — every language stored for a video. */
    public static function list(): void
    {
        [$video, $share] = WatchController::resolve();
        [$allowed] = Permissions::canWatch($video, $share);
        if (!$allowed) {
            Http::fail('Not allowed.', 403);
        }
        $rows = Db::all(
            'SELECT id, lang, label, source, is_default, created_at,
                    CHAR_LENGTH(plain_text) AS chars
             FROM transcripts WHERE video_id = ? ORDER BY is_default DESC, id ASC',
            [(int)$video['id']]
        );
        Http::ok(['transcripts' => array_map(static fn(array $r) => [
            'id'         => (int)$r['id'],
            'lang'       => $r['lang'],
            'label'      => $r['label'],
            'source'     => $r['source'],
            'is_default' => (int)$r['is_default'] === 1,
            'characters' => (int)$r['chars'],
            'created_at' => $r['created_at'],
        ], $rows)]);
    }

    /**
     * POST /api/transcript/transcribe — relay one audio chunk to a speech-to-text
     * endpoint and return timed segments.
     *
     * The browser extracts and downsamples the audio, because the server has no
     * ffmpeg to do it with and a raw recording is far too large to forward. Each
     * chunk carries the offset it starts at so the pieces line up.
     */
    public static function transcribe(): void
    {
        $video = VideoController::find((string)($_POST['uid'] ?? ''));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only transcribe your own videos.', 403);
        }

        $apiKey = (string)Config::setting('ai_api_key', '');
        if ($apiKey === '') {
            Http::fail('No AI key is configured. Add one in Settings → Instance admin → AI.', 422);
        }
        if (!function_exists('curl_init')) {
            Http::fail('The cURL PHP extension is required to reach the transcription service.', 500);
        }
        if (empty($_FILES['audio']) || ($_FILES['audio']['error'] ?? 1) !== UPLOAD_ERR_OK) {
            Http::fail('No audio chunk was received.');
        }

        $offset = max(0.0, (float)($_POST['offset'] ?? 0));
        $language = preg_replace('/[^a-z-]/i', '', (string)($_POST['language'] ?? '')) ?: null;

        $base  = rtrim((string)Config::setting('ai_base_url', 'https://api.openai.com/v1'), '/');
        $model = (string)Config::setting('ai_transcribe_model', 'whisper-1');

        $fields = [
            'file' => new CURLFile(
                $_FILES['audio']['tmp_name'],
                'audio/wav',
                'chunk.wav'
            ),
            'model'           => $model,
            'response_format' => 'verbose_json',
        ];
        if ($language) {
            $fields['language'] = $language;
        }

        $ch = curl_init($base . '/audio/transcriptions');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 300,
            CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $apiKey],
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $fields,
        ]);
        $body = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);

        if ($body === false || $status >= 400) {
            error_log('[myloom][stt] ' . $status . ' ' . ($error ?: substr((string)$body, 0, 400)));
            Http::fail('The transcription service refused the request (HTTP ' . $status . '). '
                . 'Check the API key and model in Settings → Instance admin.', 502);
        }

        $json = json_decode((string)$body, true);
        if (!is_array($json)) {
            Http::fail('The transcription service returned something unreadable.', 502);
        }

        $segments = [];
        foreach (($json['segments'] ?? []) as $segment) {
            $text = trim((string)($segment['text'] ?? ''));
            if ($text === '') {
                continue;
            }
            $segments[] = [
                'start' => round($offset + (float)($segment['start'] ?? 0), 2),
                'end'   => round($offset + (float)($segment['end'] ?? 0), 2),
                'text'  => mb_substr($text, 0, 500),
            ];
        }
        // Some endpoints return only the full text; keep it rather than nothing.
        if (!$segments && !empty($json['text'])) {
            $segments[] = [
                'start' => round($offset, 2),
                'end'   => round($offset + (float)($_POST['duration'] ?? 30), 2),
                'text'  => mb_substr(trim((string)$json['text']), 0, 500),
            ];
        }

        Http::ok([
            'segments' => $segments,
            'language' => $json['language'] ?? $language,
        ]);
    }

    /** POST /api/transcript/translate — a translated copy of an existing transcript. */
    public static function translate(): void
    {
        $video = VideoController::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only edit your own videos.', 403);
        }
        $apiKey = (string)Config::setting('ai_api_key', '');
        if ($apiKey === '') {
            Http::fail('Translation needs an AI key. Add one in Settings → Instance admin → AI.', 422);
        }

        $targetLang  = preg_replace('/[^a-z-]/i', '', Http::str('lang')) ?: '';
        $targetLabel = mb_substr(Http::str('label', $targetLang), 0, 60);
        if ($targetLang === '') {
            Http::fail('Choose a language to translate into.');
        }

        $source = Db::one(
            'SELECT * FROM transcripts WHERE video_id = ? AND lang = ? LIMIT 1',
            [(int)$video['id'], Http::str('from', 'en')]
        ) ?: Db::one('SELECT * FROM transcripts WHERE video_id = ? ORDER BY id ASC LIMIT 1', [(int)$video['id']]);

        if (!$source) {
            Http::fail('There is no transcript to translate yet.', 422);
        }
        $segments = json_decode((string)$source['segments'], true) ?: [];
        if (!$segments) {
            Http::fail('That transcript has no lines.', 422);
        }

        // Translate line by line, in batches, so timings stay attached.
        $translated = [];
        foreach (array_chunk($segments, 40, true) as $batch) {
            $lines = [];
            foreach ($batch as $index => $segment) {
                $lines[] = $index . "	" . str_replace(["
", "
", "	"], ' ', (string)$segment['text']);
            }
            $prompt = "Translate each numbered line into " . $targetLabel . " (" . $targetLang . ").
"
                . "Reply with the same number, a tab, then only the translation — one line each, "
                . "same number of lines, no commentary.

" . implode("
", $lines);

            $reply = self::chat($apiKey, $prompt);
            foreach (explode("
", $reply) as $line) {
                if (!preg_match('/^\s*(\d+)\s*	?\s*(.+)$/u', $line, $m)) {
                    continue;
                }
                $index = (int)$m[1];
                if (!isset($segments[$index])) {
                    continue;
                }
                $translated[$index] = [
                    'start' => (float)$segments[$index]['start'],
                    'end'   => (float)$segments[$index]['end'],
                    'text'  => mb_substr(trim($m[2]), 0, 500),
                ];
            }
        }

        if (!$translated) {
            Http::fail('The translation came back empty.', 502);
        }
        ksort($translated);
        $translated = array_values($translated);

        Db::run('DELETE FROM transcripts WHERE video_id = ? AND lang = ?', [(int)$video['id'], $targetLang]);
        Db::insert('transcripts', [
            'video_id'   => (int)$video['id'],
            'lang'       => $targetLang,
            'label'      => $targetLabel ?: $targetLang,
            'segments'   => json_encode($translated, JSON_UNESCAPED_UNICODE),
            'plain_text' => mb_substr(implode(' ', array_column($translated, 'text')), 0, 4000000),
            'source'     => 'api',
            'is_default' => 0,
            'created_at' => Util::now(),
        ]);

        Http::ok(['lines' => count($translated), 'lang' => $targetLang]);
    }

    /** POST /api/transcript/delete */
    public static function delete(): void
    {
        $video = VideoController::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only edit your own videos.', 403);
        }
        Db::run('DELETE FROM transcripts WHERE video_id = ? AND lang = ?',
            [(int)$video['id'], mb_substr(Http::str('lang', 'en'), 0, 12)]);
        Http::ok();
    }

    /** POST /api/transcript/default — pick which language shows by default. */
    public static function makeDefault(): void
    {
        $video = VideoController::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only edit your own videos.', 403);
        }
        $lang = mb_substr(Http::str('lang', 'en'), 0, 12);
        Db::run('UPDATE transcripts SET is_default = 0 WHERE video_id = ?', [(int)$video['id']]);
        Db::run('UPDATE transcripts SET is_default = 1 WHERE video_id = ? AND lang = ?',
            [(int)$video['id'], $lang]);
        Http::ok();
    }

    /** Small helper for chat-completion calls shared by translate and summarise. */
    private static function chat(string $apiKey, string $prompt): string
    {
        $base  = rtrim((string)Config::setting('ai_base_url', 'https://api.openai.com/v1'), '/');
        $model = (string)Config::setting('ai_model', 'gpt-4o-mini');

        $ch = curl_init($base . '/chat/completions');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 180,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
            CURLOPT_POSTFIELDS     => json_encode([
                'model'       => $model,
                'messages'    => [['role' => 'user', 'content' => $prompt]],
                'temperature' => 0.2,
            ]),
        ]);
        $body = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($body === false || $status >= 400) {
            throw new RuntimeException('AI request failed (HTTP ' . $status . ').');
        }
        $json = json_decode((string)$body, true);
        return (string)($json['choices'][0]['message']['content'] ?? '');
    }

    /** Build a WebVTT file from stored segments. */
    public static function segmentsFor(int $videoId, string $lang = ''): array
    {
        $row = $lang !== ''
            ? Db::one('SELECT segments FROM transcripts WHERE video_id = ? AND lang = ? LIMIT 1', [$videoId, $lang])
            : null;
        if (!$row) {
            $row = Db::one(
                'SELECT segments FROM transcripts WHERE video_id = ? ORDER BY is_default DESC, id ASC LIMIT 1',
                [$videoId]
            );
        }
        return $row ? (json_decode((string)$row['segments'], true) ?: []) : [];
    }

    public static function vtt(int $videoId, string $lang = ''): string
    {
        $segments = self::segmentsFor($videoId, $lang);
        $out = "WEBVTT\n\n";
        foreach ($segments as $i => $seg) {
            $out .= ($i + 1) . "\n"
                . self::stamp((float)$seg['start']) . ' --> ' . self::stamp((float)$seg['end']) . "\n"
                . str_replace(["\r", "\n"], ' ', (string)$seg['text']) . "\n\n";
        }
        return $out;
    }

    /** SubRip captions — what most video editors and social platforms expect. */
    public static function srt(int $videoId, string $lang = ''): string
    {
        $segments = self::segmentsFor($videoId, $lang);
        $out = '';
        foreach ($segments as $i => $seg) {
            $out .= ($i + 1) . "\r\n"
                . str_replace('.', ',', self::stamp((float)$seg['start'])) . ' --> '
                . str_replace('.', ',', self::stamp((float)$seg['end'])) . "\r\n"
                . str_replace(["\r", "\n"], ' ', (string)$seg['text']) . "\r\n\r\n";
        }
        return $out;
    }

    private static function stamp(float $seconds): string
    {
        $h = intdiv((int)$seconds, 3600);
        $m = intdiv((int)$seconds % 3600, 60);
        $s = (int)$seconds % 60;
        $ms = (int)round(($seconds - floor($seconds)) * 1000);
        return sprintf('%02d:%02d:%02d.%03d', $h, $m, $s, $ms);
    }

    /** POST /api/transcript/summarize — AI title + summary + chapters, with a local fallback. */
    public static function summarize(): void
    {
        $video = VideoController::find(Http::str('uid'));
        if (!Permissions::canManageVideo($video)) {
            Http::fail('You can only edit your own videos.', 403);
        }
        $row = Db::one('SELECT * FROM transcripts WHERE video_id = ? ORDER BY id ASC LIMIT 1', [(int)$video['id']]);
        if (!$row || trim((string)$row['plain_text']) === '') {
            Http::fail('This video has no transcript yet. Record with "Capture transcript" enabled, or paste one in.', 422);
        }

        $text = (string)$row['plain_text'];
        $apiKey = (string)Config::setting('ai_api_key', '');

        if ($apiKey !== '') {
            try {
                $result = self::callAi($apiKey, $text, (float)$video['duration']);
                self::applySummary($video, $result);
                Http::ok(['source' => 'ai'] + $result);
            } catch (Throwable $e) {
                error_log('[myloom][ai] ' . $e->getMessage());
                // Fall through to the local summariser rather than failing outright.
            }
        }

        $result = self::localSummary($text, (float)$video['duration'],
            json_decode((string)$row['segments'], true) ?: []);
        self::applySummary($video, $result);
        Http::ok(['source' => 'local'] + $result);
    }

    private static function applySummary(array $video, array $result): void
    {
        $data = ['updated_at' => Util::now()];
        if (!empty($result['summary'])) {
            $data['summary'] = mb_substr((string)$result['summary'], 0, 20000);
        }
        if (!empty($result['title']) && (
            $video['title'] === 'Untitled recording' || Http::bool('overwrite_title'))) {
            $data['title'] = mb_substr((string)$result['title'], 0, 255);
        }
        Db::update('videos', $data, 'id = ?', [(int)$video['id']]);

        if (!empty($result['chapters']) && is_array($result['chapters'])) {
            Db::run('DELETE FROM video_chapters WHERE video_id = ?', [(int)$video['id']]);
            foreach (array_slice($result['chapters'], 0, 50) as $c) {
                $title = trim((string)($c['title'] ?? ''));
                if ($title === '') {
                    continue;
                }
                Db::insert('video_chapters', [
                    'video_id'   => (int)$video['id'],
                    'start_time' => max(0, (float)($c['start_time'] ?? 0)),
                    'title'      => mb_substr($title, 0, 200),
                ]);
            }
        }
    }

    /** Call an OpenAI-compatible chat completions endpoint. */
    private static function callAi(string $apiKey, string $text, float $duration): array
    {
        if (!function_exists('curl_init')) {
            throw new RuntimeException('cURL is not available on this server.');
        }
        $base  = rtrim((string)Config::setting('ai_base_url', 'https://api.openai.com/v1'), '/');
        $model = (string)Config::setting('ai_model', 'gpt-4o-mini');

        $prompt = "You are summarising a screen-recording transcript.\n"
            . "Video length: " . round($duration) . " seconds.\n"
            . "Reply with JSON only, shaped as "
            . '{"title": string, "summary": string, "chapters": [{"start_time": number, "title": string}]}.' . "\n"
            . "Title: max 8 words. Summary: 2-4 sentences plus key points as '- ' lines. "
            . "Chapters: 3-8 entries with start_time in seconds inside the video length.\n\n"
            . "Transcript:\n" . mb_substr($text, 0, 24000);

        $ch = curl_init($base . '/chat/completions');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 60,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $apiKey,
            ],
            CURLOPT_POSTFIELDS => json_encode([
                'model'    => $model,
                'messages' => [['role' => 'user', 'content' => $prompt]],
                'temperature' => 0.3,
            ]),
        ]);
        $body = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);

        if ($body === false || $status >= 400) {
            throw new RuntimeException('AI request failed (' . $status . '): ' . ($err ?: substr((string)$body, 0, 200)));
        }
        $json = json_decode((string)$body, true);
        $content = $json['choices'][0]['message']['content'] ?? '';
        if (preg_match('/\{.*\}/s', (string)$content, $m)) {
            $content = $m[0];
        }
        $parsed = json_decode((string)$content, true);
        if (!is_array($parsed)) {
            throw new RuntimeException('The AI response was not valid JSON.');
        }
        return [
            'title'    => (string)($parsed['title'] ?? ''),
            'summary'  => (string)($parsed['summary'] ?? ''),
            'chapters' => is_array($parsed['chapters'] ?? null) ? $parsed['chapters'] : [],
        ];
    }

    /**
     * Offline summariser: frequency-scored sentence extraction plus evenly
     * spaced chapters seeded from the transcript. No external service needed.
     */
    private static function localSummary(string $text, float $duration, array $segments): array
    {
        $sentences = preg_split('/(?<=[.!?])\s+/u', trim($text)) ?: [];
        $sentences = array_values(array_filter(array_map('trim', $sentences), static fn($s) => mb_strlen($s) > 25));

        $stop = array_flip(['the','and','that','this','with','have','from','they','you','your','for','are','was','but',
            'not','all','can','will','just','what','when','then','there','their','about','into','some','like','okay',
            'right','going','really','actually','know','here','were','been','also','over','than','them','out','get',
            'got','has','how','one','its','our','who','why','which','more','very','because','would','could','should']);

        $freq = [];
        foreach (preg_split('/\W+/u', mb_strtolower($text)) ?: [] as $word) {
            if (mb_strlen($word) < 4 || isset($stop[$word])) {
                continue;
            }
            $freq[$word] = ($freq[$word] ?? 0) + 1;
        }
        arsort($freq);

        $scores = [];
        foreach ($sentences as $i => $sentence) {
            $score = 0;
            foreach (preg_split('/\W+/u', mb_strtolower($sentence)) ?: [] as $word) {
                $score += $freq[$word] ?? 0;
            }
            $scores[$i] = $score / max(1, sqrt(mb_strlen($sentence)));
        }
        arsort($scores);
        $pick = array_slice(array_keys($scores), 0, 4);
        sort($pick);

        $summary = '';
        foreach ($pick as $i) {
            $summary .= $sentences[$i] . ' ';
        }
        $summary = trim($summary);
        if ($summary === '') {
            $summary = mb_substr($text, 0, 400);
        }

        $keywords = array_slice(array_keys($freq), 0, 5);
        if ($keywords) {
            $summary .= "\n\nKey topics: " . implode(', ', $keywords) . '.';
        }

        $title = $sentences ? mb_substr($sentences[0], 0, 70) : ($keywords ? ucfirst($keywords[0]) . ' walkthrough' : '');
        $title = rtrim($title, ' .,');

        $chapters = [];
        if ($segments && $duration > 60) {
            $count = min(6, max(3, (int)floor($duration / 90)));
            $step  = $duration / $count;
            for ($i = 0; $i < $count; $i++) {
                $at = $i * $step;
                $label = '';
                foreach ($segments as $seg) {
                    if ((float)$seg['start'] >= $at) {
                        $label = mb_substr((string)$seg['text'], 0, 48);
                        break;
                    }
                }
                $chapters[] = [
                    'start_time' => round($at, 2),
                    'title'      => $label !== '' ? rtrim($label, ' .,') : 'Part ' . ($i + 1),
                ];
            }
        }

        return ['title' => $title, 'summary' => $summary, 'chapters' => $chapters];
    }
}
