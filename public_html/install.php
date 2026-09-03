<?php
/**
 * MyLoom installer.
 * Walks through requirements → database → admin account, writes
 * _app/config.local.php, and imports database/schema.sql.
 * Delete this file (or let the last step delete it) once you are done.
 */
require_once __DIR__ . '/_app/bootstrap.php';

$step   = $_GET['step'] ?? (myloom_installed() ? 'done' : 'requirements');
$errors = [];
$notice = '';

/** Requirement probe used by step 1. */
function myloom_requirements(): array
{
    $storage = PUBLIC_DIR . '/_storage';
    if (!is_dir($storage)) {
        @mkdir($storage, 0755, true);
    }
    return [
        ['PHP 8.0 or newer',        version_compare(PHP_VERSION, '8.0.0', '>='), PHP_VERSION, true],
        ['PDO MySQL driver',        extension_loaded('pdo_mysql'), extension_loaded('pdo_mysql') ? 'loaded' : 'missing', true],
        ['JSON extension',          extension_loaded('json'), extension_loaded('json') ? 'loaded' : 'missing', true],
        ['mbstring extension',      extension_loaded('mbstring'), extension_loaded('mbstring') ? 'loaded' : 'missing', true],
        ['fileinfo extension',      extension_loaded('fileinfo'), extension_loaded('fileinfo') ? 'loaded' : 'missing', true],
        ['_storage is writable',    is_writable($storage), is_writable($storage) ? 'writable' : 'not writable — chmod 755', true],
        ['_app is writable (config)', is_writable(APP_DIR), is_writable(APP_DIR) ? 'writable' : 'not writable — chmod 755', true],
        ['cURL (optional, for AI)', extension_loaded('curl'), extension_loaded('curl') ? 'loaded' : 'not loaded', false],
        ['OpenSSL (optional, SMTP)', extension_loaded('openssl'), extension_loaded('openssl') ? 'loaded' : 'not loaded', false],
    ];
}

// --------------------------------------------------------------------------
// Step handlers
// --------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'POST' && !myloom_installed()) {
    $action = $_POST['action'] ?? '';

    if ($action === 'database') {
        $cfg = [
            'db_host' => trim($_POST['db_host'] ?? 'localhost'),
            'db_port' => (int)($_POST['db_port'] ?? 3306),
            'db_name' => trim($_POST['db_name'] ?? ''),
            'db_user' => trim($_POST['db_user'] ?? ''),
            'db_pass' => (string)($_POST['db_pass'] ?? ''),
        ];
        if ($cfg['db_name'] === '' || $cfg['db_user'] === '') {
            $errors[] = 'Database name and username are required.';
        } else {
            try {
                $pdo = Db::connectWith($cfg);
                $sql = false;
                foreach ([APP_DIR . '/schema.sql', dirname(PUBLIC_DIR) . '/database/schema.sql', PUBLIC_DIR . '/schema.sql'] as $candidate) {
                    if (is_file($candidate)) {
                        $sql = file_get_contents($candidate);
                        break;
                    }
                }
                if ($sql === false) {
                    throw new RuntimeException('schema.sql could not be found. Re-upload _app/schema.sql from the package.');
                }
                // Import statement by statement so partial failures are reportable.
                foreach (preg_split('/;\s*\n/', $sql) ?: [] as $statement) {
                    $statement = trim($statement);
                    if ($statement === '' || str_starts_with($statement, '--')) {
                        continue;
                    }
                    $pdo->exec($statement);
                }
                $_SESSION_CFG = $cfg;
                $_SESSION_CFG['app_url']    = rtrim(trim($_POST['app_url'] ?? Util::guessBaseUrl()), '/');
                $_SESSION_CFG['app_secret'] = Util::token(32);
                $_SESSION_CFG['max_upload_mb'] = max(1, (int)($_POST['max_upload_mb'] ?? 4096));
                $_SESSION_CFG['mail_from']  = trim($_POST['mail_from'] ?? '');
                $_SESSION_CFG['allow_signup'] = isset($_POST['allow_signup']);
                $_SESSION_CFG['storage_dir'] = PUBLIC_DIR . '/_storage';

                if (!Config::write($_SESSION_CFG)) {
                    throw new RuntimeException('Could not write _app/config.local.php. Set the _app folder to permission 755 and retry.');
                }
                Config::load();
                Storage::ensure();
                header('Location: install.php?step=admin');
                exit;
            } catch (Throwable $e) {
                $errors[] = $e->getMessage();
            }
        }
    }

    if ($action === 'admin') {
        Config::load();
        $name  = trim($_POST['name'] ?? '');
        $email = strtolower(trim($_POST['email'] ?? ''));
        $pass  = (string)($_POST['password'] ?? '');
        $wsName = trim($_POST['workspace'] ?? '') ?: ($name . "'s workspace");

        if (mb_strlen($name) < 2) {
            $errors[] = 'Enter your name.';
        }
        if (!Util::isEmail($email)) {
            $errors[] = 'Enter a valid email address.';
        }
        if (strlen($pass) < 8) {
            $errors[] = 'Choose a password with at least 8 characters.';
        }

        if (!$errors) {
            try {
                require_once APP_DIR . '/controllers/WorkspaceController.php';
                $userId = Db::insert('users', [
                    'name'           => $name,
                    'email'          => $email,
                    'password_hash'  => password_hash($pass, PASSWORD_DEFAULT),
                    'is_admin'       => 1,
                    'email_verified' => 1,
                    'created_at'     => Util::now(),
                ]);
                WorkspaceController::createWorkspace($userId, $wsName);
                Config::putSetting('site_name', trim($_POST['site_name'] ?? 'MyLoom') ?: 'MyLoom');
                Auth::login($userId);
                header('Location: install.php?step=done');
                exit;
            } catch (Throwable $e) {
                $errors[] = $e->getMessage();
            }
        }
    }
}

if (isset($_GET['remove']) && myloom_installed()) {
    @unlink(__FILE__);
    header('Location: ' . Util::basePath() . '/');
    exit;
}

if (myloom_installed() && $step !== 'done') {
    $step = 'done';
    $notice = 'MyLoom is already installed. Delete install.php to hide this page.';
}
$requirements = myloom_requirements();
$blocking = array_filter($requirements, static fn($r) => $r[3] && !$r[1]);
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install MyLoom</title>
<style>
  :root{--accent:#625df5;--bg:#f5f5fa;--card:#fff;--line:#e6e6ef;--text:#1b1b23;--muted:#71717f;--ok:#12a150;--bad:#e5484d}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:40px 16px}
  .wrap{max-width:660px;margin:0 auto}
  .logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;margin-bottom:22px}
  .logo i{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#625df5,#8b5cf6);display:block}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px;box-shadow:0 1px 2px rgba(20,20,40,.04)}
  h1{font-size:21px;margin:0 0 6px}
  p.sub{color:var(--muted);margin:0 0 22px}
  .steps{display:flex;gap:8px;margin-bottom:22px;font-size:13px;color:var(--muted);flex-wrap:wrap}
  .steps b{color:var(--accent)}
  label{display:block;font-weight:600;font-size:13px;margin:16px 0 6px}
  input[type=text],input[type=password],input[type=email],input[type=number]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;font:inherit;background:#fff}
  input:focus{outline:2px solid rgba(98,93,245,.3);border-color:var(--accent)}
  .row{display:flex;gap:12px}.row>*{flex:1}
  .btn{display:inline-block;margin-top:22px;background:var(--accent);color:#fff;border:0;border-radius:10px;padding:12px 20px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
  .btn:hover{filter:brightness(1.06)}
  .btn.ghost{background:#fff;color:var(--text);border:1px solid var(--line)}
  table{width:100%;border-collapse:collapse;font-size:14px}
  td{padding:9px 0;border-bottom:1px solid var(--line)}
  td:last-child{text-align:right;color:var(--muted)}
  .ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}.warn{color:#c08a00;font-weight:600}
  .alert{background:#fdecec;border:1px solid #f5c2c2;color:#a3222a;padding:12px 14px;border-radius:9px;margin-bottom:16px;font-size:14px}
  .note{background:#f0f0fb;border:1px solid #d8d8f5;padding:12px 14px;border-radius:9px;font-size:14px;color:#3c3c6e}
  .hint{color:var(--muted);font-size:12.5px;margin-top:5px}
  code{background:#f2f2f7;padding:2px 6px;border-radius:5px;font-size:13px}
  .check{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:14px}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo"><i></i> MyLoom installer</div>

  <div class="steps">
    <span <?= $step === 'requirements' ? 'class="b"' : '' ?>><?= $step === 'requirements' ? '<b>1. Requirements</b>' : '1. Requirements' ?></span> ·
    <span><?= $step === 'database' ? '<b>2. Database</b>' : '2. Database' ?></span> ·
    <span><?= $step === 'admin' ? '<b>3. Admin account</b>' : '3. Admin account' ?></span> ·
    <span><?= $step === 'done' ? '<b>4. Finish</b>' : '4. Finish' ?></span>
  </div>

  <div class="card">
    <?php foreach ($errors as $error): ?>
      <div class="alert"><?= Util::e($error) ?></div>
    <?php endforeach; ?>
    <?php if ($notice !== ''): ?><div class="note"><?= Util::e($notice) ?></div><?php endif; ?>

    <?php if ($step === 'requirements'): ?>
      <h1>Server check</h1>
      <p class="sub">Everything marked required must pass before you continue.</p>
      <table>
        <?php foreach ($requirements as [$label, $pass, $detail, $required]): ?>
          <tr>
            <td><?= Util::e($label) ?><?= $required ? '' : ' <span style="color:#a1a1ad">(optional)</span>' ?></td>
            <td><span class="<?= $pass ? 'ok' : ($required ? 'bad' : 'warn') ?>"><?= Util::e($detail) ?></span></td>
          </tr>
        <?php endforeach; ?>
      </table>
      <?php if ($blocking): ?>
        <div class="alert" style="margin-top:18px">Fix the items in red, then reload this page. In cPanel, folder permissions live under File Manager → right-click the folder → Change Permissions.</div>
        <a class="btn ghost" href="install.php">Re-run check</a>
      <?php else: ?>
        <a class="btn" href="install.php?step=database">Continue</a>
      <?php endif; ?>

    <?php elseif ($step === 'database'): ?>
      <h1>Database connection</h1>
      <p class="sub">Create a MySQL database and user in cPanel first (MySQL® Databases), then paste the details here.</p>
      <form method="post">
        <input type="hidden" name="action" value="database">
        <div class="row">
          <div><label>Database host</label><input type="text" name="db_host" value="localhost" required></div>
          <div style="max-width:120px"><label>Port</label><input type="number" name="db_port" value="3306"></div>
        </div>
        <label>Database name</label>
        <input type="text" name="db_name" placeholder="cpaneluser_myloom" value="<?= Util::e($_POST['db_name'] ?? '') ?>" required>
        <label>Database user</label>
        <input type="text" name="db_user" placeholder="cpaneluser_myloom" value="<?= Util::e($_POST['db_user'] ?? '') ?>" required>
        <label>Database password</label>
        <input type="password" name="db_pass" autocomplete="new-password">

        <label>Site URL</label>
        <input type="text" name="app_url" value="<?= Util::e(Util::guessBaseUrl()) ?>">
        <div class="hint">Use the exact address people will visit, including https://.</div>

        <div class="row">
          <div>
            <label>Maximum recording size (MB)</label>
            <input type="number" name="max_upload_mb" value="4096" min="10">
            <div class="hint">Recordings stream to disk in chunks, so this is a storage guard, not a PHP limit.</div>
          </div>
          <div>
            <label>Notification sender address</label>
            <input type="text" name="mail_from" placeholder="no-reply@yourdomain.com">
            <div class="hint">Leave blank to use no-reply@yourdomain.</div>
          </div>
        </div>

        <div class="check">
          <input type="checkbox" name="allow_signup" id="allow_signup" checked>
          <label for="allow_signup" style="margin:0;font-weight:500">Allow public sign-ups (uncheck for an invite-only, private instance)</label>
        </div>

        <button class="btn" type="submit">Test connection &amp; create tables</button>
      </form>

    <?php elseif ($step === 'admin'): ?>
      <h1>Create your admin account</h1>
      <p class="sub">This is the first user, and it owns the first workspace.</p>
      <form method="post">
        <input type="hidden" name="action" value="admin">
        <label>Site name</label>
        <input type="text" name="site_name" value="MyLoom">
        <label>Your name</label>
        <input type="text" name="name" value="<?= Util::e($_POST['name'] ?? '') ?>" required>
        <label>Email</label>
        <input type="email" name="email" value="<?= Util::e($_POST['email'] ?? '') ?>" required>
        <label>Password</label>
        <input type="password" name="password" autocomplete="new-password" required>
        <div class="hint">At least 8 characters.</div>
        <label>Workspace name</label>
        <input type="text" name="workspace" placeholder="Acme Inc." value="<?= Util::e($_POST['workspace'] ?? '') ?>">
        <button class="btn" type="submit">Create account</button>
      </form>

    <?php else: ?>
      <h1>You're all set 🎉</h1>
      <p class="sub">MyLoom is installed and ready to record.</p>
      <div class="note">
        <strong>One last step:</strong> delete <code>install.php</code> so nobody can re-run the installer.
      </div>
      <p style="margin-top:18px">
        <a class="btn" href="install.php?remove=1">Delete installer &amp; open MyLoom</a>
        <a class="btn ghost" href="<?= Util::e(Util::url('')) ?>">Skip, open MyLoom</a>
      </p>
      <p class="hint">Recording requires HTTPS (or localhost) — browsers block screen capture on plain HTTP. Enable AutoSSL in cPanel if you have not already.</p>
    <?php endif; ?>
  </div>
</div>
</body>
</html>
