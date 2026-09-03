<?php
/**
 * MyLoom — application bootstrap.
 * Loaded by every public entry point (index.php, api.php, file.php).
 */

if (!defined('MYLOOM')) {
    define('MYLOOM', '1.0.0');
}

define('APP_DIR', __DIR__);
define('PUBLIC_DIR', dirname(__DIR__));
define('CONFIG_FILE', APP_DIR . '/config.local.php');

// Polyfills first: a host with mbstring disabled must still reach the
// installer's requirement check instead of dying on an undefined function.
require_once __DIR__ . '/compat.php';

mb_internal_encoding('UTF-8');
date_default_timezone_set('UTC');

// Show nothing to the browser; log instead. The API converts throwables to JSON.
ini_set('display_errors', '0');
ini_set('log_errors', '1');
ini_set('error_log', PUBLIC_DIR . '/_storage/logs/php-error.log');
error_reporting(E_ALL);

require_once APP_DIR . '/Config.php';
require_once APP_DIR . '/Util.php';
require_once APP_DIR . '/Db.php';
require_once APP_DIR . '/Http.php';
require_once APP_DIR . '/Auth.php';
require_once APP_DIR . '/Storage.php';
require_once APP_DIR . '/Permissions.php';
require_once APP_DIR . '/Mailer.php';
require_once APP_DIR . '/Migrations.php';

/**
 * Controllers reference each other freely (AuthController needs WorkspaceController,
 * WatchController needs VideoController, …), so resolve them on demand.
 */
spl_autoload_register(static function (string $class): void {
    if (!preg_match('/^[A-Za-z0-9_]+$/', $class)) {
        return;
    }
    foreach ([APP_DIR . '/controllers/' . $class . '.php', APP_DIR . '/' . $class . '.php'] as $file) {
        if (is_file($file)) {
            require_once $file;
            return;
        }
    }
});

Config::load();

/** True when the app has not been installed yet. */
function myloom_installed(): bool
{
    return is_file(CONFIG_FILE);
}
