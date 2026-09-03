<?php
/**
 * MyLoom API front controller.
 * Every request is routed here as /api/<segment>/<action> (see .htaccess),
 * with a ?r= fallback for servers without mod_rewrite.
 */
require_once __DIR__ . '/_app/bootstrap.php';

header('X-Frame-Options: SAMEORIGIN');
header('Referrer-Policy: strict-origin-when-cross-origin');

if (Http::method() === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if (!myloom_installed()) {
    Http::fail('MyLoom is not installed yet. Open /install.php to finish setup.', 503);
}

Storage::ensure();
Migrations::run();

/** Resolve the route from PATH_INFO, the rewritten URI, or ?r=. */
function myloom_route(): string
{
    $route = (string)($_GET['r'] ?? '');
    if ($route === '') {
        $path = Util::requestPath();
        if (preg_match('#^/api\.php/?(.*)$#', $path, $m)) {
            $route = $m[1];
        } elseif (preg_match('#^/api/?(.*)$#', $path, $m)) {
            $route = $m[1];
        }
    }
    $route = trim(preg_replace('#[^a-zA-Z0-9/_\-.]#', '', $route) ?? '', '/');
    return $route === '' ? 'ping' : $route;
}

$route = myloom_route();

$controllers = [
    'auth'          => 'AuthController',
    'workspaces'    => 'WorkspaceController',
    'spaces'        => 'SpaceController',
    'videos'        => 'VideoController',
    'upload'        => 'UploadController',
    'share'         => 'ShareController',
    'watch'         => 'WatchController',
    'comments'      => 'CommentController',
    'analytics'     => 'AnalyticsController',
    'transcript'    => 'TranscriptController',
    'annotations'   => 'AnnotationController',
    'notifications' => 'NotificationController',
    'admin'         => 'AdminController',
];

try {
    Auth::start();

    if ($route === 'ping') {
        Http::ok(['app' => 'MyLoom', 'version' => MYLOOM, 'time' => Util::now()]);
    }

    $parts = explode('/', $route);
    $group = array_shift($parts);
    $action = $parts ? implode('_', $parts) : 'index';

    if (!isset($controllers[$group])) {
        Http::fail('Unknown API endpoint: ' . $group, 404);
    }

    // Every state-changing call must carry the CSRF token from GET /api/auth/me.
    Auth::checkCsrf();

    $class = $controllers[$group];
    require_once APP_DIR . '/controllers/' . $class . '.php';

    $method = lcfirst(str_replace(' ', '', ucwords(str_replace(['-', '_'], ' ', $action))));
    if (!method_exists($class, $method)) {
        Http::fail("Unknown action '{$action}' on {$group}.", 404);
    }

    $class::$method();
    Http::ok();
} catch (PDOException $e) {
    error_log('[myloom][db] ' . $e->getMessage());
    Http::fail(
        Config::get('debug') ? 'Database error: ' . $e->getMessage() : 'A database error occurred.',
        500
    );
} catch (Throwable $e) {
    error_log('[myloom] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    Http::fail(
        Config::get('debug') ? $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine() : 'Something went wrong.',
        500
    );
}
