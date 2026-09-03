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

Config::load();

/** True when the app has not been installed yet. */
function myloom_installed(): bool
{
    return is_file(CONFIG_FILE);
}
