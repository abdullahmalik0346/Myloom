<?php
/** SPA shell. All in-app routing happens client-side in assets/js/app.js. */
$siteName = (string)Config::setting('site_name', 'MyLoom');
$boot = [
    'baseUrl'      => Config::get('app_url'),
    'basePath'     => Util::basePath(),
    'apiUrl'       => Util::url('api.php'),
    'csrf'         => Auth::csrf(),
    'siteName'     => $siteName,
    'allowSignup'  => (bool)Config::get('allow_signup'),
    'signedIn'     => Auth::check(),
    'maxUploadMb'  => (int)Config::get('max_upload_mb'),
    'version'      => MYLOOM,
];
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#625df5">
<title><?= Util::e($siteName) ?></title>
<meta name="description" content="Record your screen, share a link, see who watched.">
<link rel="icon" href="<?= Util::e(Util::url('assets/img/favicon.svg')) ?>" type="image/svg+xml">
<link rel="stylesheet" href="<?= Util::e(Util::url('assets/css/app.css?v=' . MYLOOM)) ?>">
</head>
<body class="app-body">
<script>window.MYLOOM = <?= json_encode($boot, JSON_UNESCAPED_SLASHES) ?>;</script>

<div id="app" class="app-root">
  <div class="boot-splash">
    <div class="boot-logo"></div>
    <p>Loading <?= Util::e($siteName) ?>…</p>
  </div>
</div>

<div id="toasts" class="toasts" aria-live="polite"></div>
<div id="modal-root"></div>

<?php foreach ([
    'core', 'player', 'overlays', 'export', 'audio', 'recorder', 'comments', 'editor', 'cut',
    'views', 'record', 'video', 'settings', 'app'
] as $script): ?>
<script src="<?= Util::e(Util::url('assets/js/' . $script . '.js?v=' . MYLOOM)) ?>"></script>
<?php endforeach; ?>
</body>
</html>
