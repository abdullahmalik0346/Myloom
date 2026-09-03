<?php
/**
 * Server-rendered watch page.
 * Meta tags are rendered here so links unfurl in Slack, iMessage, LinkedIn etc.
 * The player itself, gates and comments are hydrated by assets/js/watch.js.
 */
/** @var array $video */
/** @var string|null $shareToken */
$siteName  = (string)Config::setting('site_name', 'MyLoom');
$accent    = preg_match('/^#[0-9a-fA-F]{6}$/', (string)$video['ws_accent']) ? $video['ws_accent'] : '#625df5';
$pageTitle = (string)$video['title'];
$desc      = trim((string)($video['summary'] ?: $video['description'] ?: ''));
if ($desc === '') {
    $desc = 'A ' . Util::duration((float)$video['duration']) . ' video from ' . $video['owner_name'] . '.';
}
$desc = mb_substr(strip_tags($desc), 0, 190);
$canonical = $shareToken ? Util::url('s/' . $shareToken) : Util::url('v/' . $video['uid']);
$poster    = !empty($video['thumbnail']) ? Util::url('file.php?t=' . rawurlencode((string)$video['uid'])) : '';
$indexable = $video['visibility'] === 'public' && empty($video['password_hash']);

$boot = [
    'baseUrl'  => Config::get('app_url'),
    'apiUrl'   => Util::url('api.php'),
    'csrf'     => Auth::csrf(),
    'uid'      => $video['uid'],
    'token'    => $shareToken,
    'signedIn' => Auth::check(),
    'siteName' => $siteName,
    'accent'   => $accent,
];
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title><?= Util::e($pageTitle) ?> — <?= Util::e($video['ws_name'] ?: $siteName) ?></title>
<meta name="description" content="<?= Util::e($desc) ?>">
<?php if (!$indexable): ?>
<meta name="robots" content="noindex, nofollow">
<?php endif; ?>
<link rel="canonical" href="<?= Util::e($canonical) ?>">
<meta property="og:type" content="video.other">
<meta property="og:site_name" content="<?= Util::e($video['ws_name'] ?: $siteName) ?>">
<meta property="og:title" content="<?= Util::e($pageTitle) ?>">
<meta property="og:description" content="<?= Util::e($desc) ?>">
<meta property="og:url" content="<?= Util::e($canonical) ?>">
<?php if ($poster !== ''): ?>
<meta property="og:image" content="<?= Util::e($poster) ?>">
<meta property="og:image:width" content="<?= (int)($video['width'] ?: 1280) ?>">
<meta property="og:image:height" content="<?= (int)($video['height'] ?: 720) ?>">
<?php endif; ?>
<meta name="twitter:card" content="<?= $poster !== '' ? 'summary_large_image' : 'summary' ?>">
<meta name="twitter:title" content="<?= Util::e($pageTitle) ?>">
<meta name="twitter:description" content="<?= Util::e($desc) ?>">
<?php if ($poster !== ''): ?>
<meta name="twitter:image" content="<?= Util::e($poster) ?>">
<?php endif; ?>
<meta name="theme-color" content="<?= Util::e($accent) ?>">
<link rel="icon" href="<?= Util::e(Util::url('assets/img/favicon.svg')) ?>" type="image/svg+xml">
<link rel="stylesheet" href="<?= Util::e(Util::url('assets/css/app.css?v=' . MYLOOM)) ?>">
<style>:root{--accent: <?= Util::e($accent) ?>;}</style>
</head>
<body class="watch-body">
<script>window.MYLOOM = <?= json_encode($boot, JSON_UNESCAPED_SLASHES) ?>;</script>

<header class="watch-top">
  <a class="watch-brand" href="<?= Util::e(Util::url('')) ?>">
    <?php if (!empty($video['ws_logo'])): ?>
      <img src="<?= Util::e(Util::url('file.php?a=' . rawurlencode((string)$video['ws_logo']))) ?>" alt="">
    <?php else: ?>
      <span class="brand-mark"></span>
    <?php endif; ?>
    <span><?= Util::e($video['ws_name'] ?: $siteName) ?></span>
  </a>
  <div id="watch-top-actions" class="watch-top-actions"></div>
</header>

<main id="watch-root" class="watch-root">
  <noscript>
    <p class="pad">This player needs JavaScript. <a href="<?= Util::e(Util::url('file.php?v=' . rawurlencode((string)$video['uid']) . '&dl=1')) ?>">Download the video</a> instead.</p>
  </noscript>
  <div class="watch-skeleton"><div class="sk-player"></div><div class="sk-line"></div><div class="sk-line short"></div></div>
</main>

<div id="toasts" class="toasts" aria-live="polite"></div>
<div id="modal-root"></div>

<script src="<?= Util::e(Util::url('assets/js/core.js?v=' . MYLOOM)) ?>"></script>
<script src="<?= Util::e(Util::url('assets/js/player.js?v=' . MYLOOM)) ?>"></script>
<script src="<?= Util::e(Util::url('assets/js/watch.js?v=' . MYLOOM)) ?>"></script>
</body>
</html>
