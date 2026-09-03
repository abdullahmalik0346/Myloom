<?php
/**
 * Local development router for PHP's built-in server.
 * It emulates the mod_rewrite rules in public_html/.htaccess.
 *
 *   php -S 127.0.0.1:8080 -t public_html dev-server.php
 *
 * Not used in production — cPanel/Apache uses .htaccess instead.
 */
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';

// Never expose application source or storage.
if (preg_match('#^/(_app|_storage)/#', $path)) {
    http_response_code(403);
    exit('Forbidden');
}

// Serve real files (assets, install.php, api.php, file.php) as-is.
$file = __DIR__ . '/public_html' . $path;
if ($path !== '/' && is_file($file)) {
    return false;
}

// /api/<route> -> api.php?r=<route>
if (preg_match('#^/api/(.*)$#', $path, $m)) {
    $_GET['r'] = $m[1];
    $_SERVER['SCRIPT_NAME'] = '/api.php';
    require __DIR__ . '/public_html/api.php';
    return true;
}

$_SERVER['SCRIPT_NAME'] = '/index.php';
require __DIR__ . '/public_html/index.php';
return true;
