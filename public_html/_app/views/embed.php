<?php
/** Minimal chrome-free player for iframe embeds. */
/** @var array $video */
/** @var string|null $shareToken */
$accent = preg_match('/^#[0-9a-fA-F]{6}$/', (string)$video['ws_accent']) ? $video['ws_accent'] : '#625df5';
$boot = [
    'baseUrl'  => Config::get('app_url'),
    'apiUrl'   => Util::url('api.php'),
    'csrf'     => Auth::csrf(),
    'uid'      => $video['uid'],
    'token'    => $shareToken,
    'embed'    => true,
    'accent'   => $accent,
];
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= Util::e((string)$video['title']) ?></title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="<?= Util::e(Util::url('assets/css/app.css?v=' . MYLOOM)) ?>">
<style>
  :root{--accent: <?= Util::e($accent) ?>;}
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  .embed-root{height:100vh;width:100vw}
</style>
</head>
<body class="embed-body">
<script>window.MYLOOM = <?= json_encode($boot, JSON_UNESCAPED_SLASHES) ?>;</script>
<div id="watch-root" class="embed-root"></div>
<script src="<?= Util::e(Util::url('assets/js/core.js?v=' . MYLOOM)) ?>"></script>
<script src="<?= Util::e(Util::url('assets/js/player.js?v=' . MYLOOM)) ?>"></script>
<script src="<?= Util::e(Util::url('assets/js/overlays.js?v=' . MYLOOM)) ?>"></script>
<script src="<?= Util::e(Util::url('assets/js/export.js?v=' . MYLOOM)) ?>"></script>
<script src="<?= Util::e(Util::url('assets/js/watch.js?v=' . MYLOOM)) ?>"></script>
</body>
</html>
