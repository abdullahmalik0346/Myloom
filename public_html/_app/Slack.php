<?php
/**
 * Slack notifications via an Incoming Webhook.
 *
 * A webhook URL is all Slack needs — no OAuth app, no tokens to rotate — which
 * suits a self-hosted install. Failures are logged and swallowed: a Slack
 * outage must never break commenting or watching.
 */
final class Slack
{
    /** @var array<int, array{0:string,1:string,2:array}> messages waiting to be sent */
    private static array $queue = [];
    private static bool $scheduled = false;

    /**
     * Queue a message for one workspace event, if it is enabled.
     *
     * Sending is deferred until after the response has gone out. A webhook that
     * has been deleted, or a slow Slack, must not make commenting or watching
     * feel broken — without this, every comment would wait on the round trip.
     */
    public static function notify(int $workspaceId, string $event, string $text, array $context = []): bool
    {
        $workspace = Db::one(
            'SELECT slack_webhook, slack_events, name FROM workspaces WHERE id = ?',
            [$workspaceId]
        );
        if (!$workspace || empty($workspace['slack_webhook'])) {
            return false;
        }
        $enabled = array_filter(array_map('trim', explode(',', (string)$workspace['slack_events'])));
        if (!in_array($event, $enabled, true)) {
            return false;
        }
        self::$queue[] = [(string)$workspace['slack_webhook'], $text, $context];
        if (!self::$scheduled) {
            self::$scheduled = true;
            register_shutdown_function([self::class, 'flush']);
        }
        return true;
    }

    /** Deliver anything queued, after the user's response has been sent. */
    public static function flush(): void
    {
        if (!self::$queue) {
            return;
        }
        $queue = self::$queue;
        self::$queue = [];

        // Hand the response back to the browser before talking to Slack.
        if (function_exists('fastcgi_finish_request')) {
            @fastcgi_finish_request();
        }
        @ignore_user_abort(true);

        foreach ($queue as [$webhook, $text, $context]) {
            self::post($webhook, $text, $context);
        }
    }

    /** Post a Block Kit message. Public so the settings page can send a test. */
    public static function post(string $webhook, string $text, array $context = []): bool
    {
        if (!preg_match('#^https://hooks\.slack\.com/#i', $webhook)) {
            return false;
        }
        if (!function_exists('curl_init')) {
            error_log('[myloom][slack] cURL is not available');
            return false;
        }

        $blocks = [[
            'type' => 'section',
            'text' => ['type' => 'mrkdwn', 'text' => $text],
        ]];
        if (!empty($context['url'])) {
            $blocks[] = [
                'type' => 'actions',
                'elements' => [[
                    'type' => 'button',
                    'text' => ['type' => 'plain_text', 'text' => $context['button'] ?? 'Watch'],
                    'url'  => $context['url'],
                ]],
            ];
        }

        $ch = curl_init($webhook);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_TIMEOUT        => 6,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS     => json_encode([
                'text'   => strip_tags($text),   // fallback for notifications
                'blocks' => $blocks,
            ]),
        ]);
        $body = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($status !== 200) {
            error_log('[myloom][slack] webhook failed with HTTP ' . $status
                . ' — check the URL in Workspace settings. ' . substr((string)$body, 0, 200));
            return false;
        }
        return true;
    }
}
