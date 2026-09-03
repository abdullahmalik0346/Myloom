<?php $siteName = (string)Config::setting('site_name', 'MyLoom'); ?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Video not found — <?= Util::e($siteName) ?></title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="<?= Util::e(Util::url('assets/css/app.css?v=' . MYLOOM)) ?>">
</head>
<body class="watch-body">
<main class="empty-state tall">
  <div class="empty-icon">🔍</div>
  <h1>This video isn't available</h1>
  <p>The link may have been deleted, revoked, or it may have expired.</p>
  <a class="btn primary" href="<?= Util::e(Util::url('')) ?>">Go to <?= Util::e($siteName) ?></a>
</main>
</body>
</html>
