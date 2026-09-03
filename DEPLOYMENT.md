# Deploying MyLoom on cPanel

Start to finish this takes about ten minutes. Nothing here needs SSH, Composer,
Node or a VPS — it is all File Manager and the cPanel database wizard.

---

## Before you start

**You need HTTPS.** Chrome, Edge, Firefox and Safari all refuse to give a page
access to the screen, camera or microphone unless it is served over `https://`.
Watching videos works fine on HTTP; *recording* will not.

In cPanel go to **SSL/TLS Status**, tick your domain, and click **Run AutoSSL**.
Wait for the padlock to turn green before you test recording.

Check your PHP version too: **MultiPHP Manager** → set the domain to **PHP 8.0
or newer**. The installer will refuse to continue on anything older.

---

## Step 1 — Create the database

1. cPanel → **MySQL® Databases**.
2. Under *Create New Database*, enter `myloom` and click **Create Database**.
   cPanel prefixes it with your account name, so you end up with something like
   `acmeuser_myloom`. **Write the full name down.**
3. Under *MySQL Users → Add New User*, create a user (e.g. `myloom`) and use the
   password generator. **Copy the password somewhere safe** — cPanel will not
   show it again.
4. Under *Add User To Database*, pick the user and the database, click **Add**,
   then tick **ALL PRIVILEGES** and **Make Changes**.

You now have three values: database name, username, password. The host is
`localhost` on virtually every cPanel server.

---

## Step 2 — Upload the files

Download this repository as a ZIP (GitHub → *Code* → *Download ZIP*), then:

1. cPanel → **File Manager** → open `public_html` (or the subfolder for the
   domain/subdomain you want MyLoom on).
2. Click **Upload** and send the ZIP.
3. Back in File Manager, right-click the ZIP → **Extract**.
4. Open the extracted folder and move **the contents of `public_html/`** into
   your real `public_html`. You should end up with `index.php`, `api.php`,
   `file.php`, `install.php`, `.htaccess`, `assets/`, `_app/` and `_storage/`
   sitting directly in `public_html`.
5. Delete the ZIP and the leftover extracted folder.

> Hidden files: if you cannot see `.htaccess`, click **Settings** in the top
> right of File Manager and tick **Show Hidden Files (dotfiles)**. The
> `.htaccess` file is required — it routes pretty URLs and blocks `_app/` and
> `_storage/` from the web.

### Installing into a subfolder or subdomain

Both work with no changes. For `yourdomain.com/videos`, put the files in
`public_html/videos`. For `videos.yourdomain.com`, create the subdomain first
and put the files in the document root cPanel assigns it. The installer detects
the URL either way — just confirm it looks right on the database step.

---

## Step 3 — Set folder permissions

MyLoom writes recordings into `_storage` and its config into `_app`.

In File Manager, right-click **`_storage`** → **Change Permissions** → set to
**755**, tick *Recurse into subdirectories*, and apply. Do the same for
**`_app`**.

If your host runs PHP as a different user (rare on modern cPanel with PHP-FPM),
use **775** instead. The installer tells you which of these it needs.

---

## Step 4 — Run the installer

Open `https://yourdomain.com/install.php`.

1. **Server check** — everything in the *required* rows must be green. The two
   that usually fail are folder permissions (step 3) and an old PHP version
   (MultiPHP Manager).
2. **Database** — paste the three values from step 1. Confirm the *Site URL* is
   exactly how people will reach the site, including `https://`. Set a maximum
   recording size, and untick *Allow public sign-ups* if you want an
   invite-only, private instance.
3. **Admin account** — your name, email and a password of 8+ characters, plus a
   name for your first workspace.
4. **Finish** — click **Delete installer & open MyLoom**. This removes
   `install.php` so nobody can re-run setup against your database.

You are done. Record something.

---

## Recommended: raise the PHP limits

Recordings upload in small chunks, so they are **not** affected by
`upload_max_filesize`. Those limits only matter for *Library → Upload*, when you
import an existing video file.

If you want big imports to work, cPanel → **MultiPHP INI Editor** → pick your
domain → set:

| Setting | Suggested |
|---|---|
| `upload_max_filesize` | `512M` |
| `post_max_size` | `512M` |
| `max_execution_time` | `600` |
| `memory_limit` | `256M` |

The bundled `.htaccess` also tries to set these, but many hosts ignore
`php_value` directives; the INI Editor is authoritative. If your host returns a
**500 error** after upload, that is usually the cause — open `.htaccess` and
delete the `<IfModule mod_php.c>` block at the bottom.

---

## Email notifications

Out of the box MyLoom uses PHP's `mail()`, which most cPanel servers provide.
Deliverability is much better through authenticated SMTP. Edit
`_app/config.local.php` and fill in:

```php
'mail_from'      => 'no-reply@yourdomain.com',
'mail_from_name' => 'Your Company',
'smtp_host'      => 'mail.yourdomain.com',
'smtp_port'      => 587,
'smtp_user'      => 'no-reply@yourdomain.com',
'smtp_pass'      => 'the mailbox password',
'smtp_secure'    => 'tls',      // 'tls', 'ssl' or '' for none
```

Create the mailbox first in cPanel → **Email Accounts**. Use port `465` with
`'ssl'` if `587` is blocked.

Invitations always show you a copyable link, so team invites still work even if
email is not configured.

---

## Optional: AI summaries

Without any configuration, MyLoom summarises transcripts with a built-in
offline summariser — no external service, no key, no data leaving your server.

To use a real model instead, sign in as the admin → **Settings → Instance
admin → AI summaries** and provide an API key. Any OpenAI-compatible endpoint
works (OpenAI, Anthropic-compatible gateways, OpenRouter, a local llama.cpp
server). Requires the `curl` PHP extension. Transcripts are sent to whichever
endpoint you configure — leave it blank to keep everything local.

---

## Backups

Two things matter:

- **The database** — cPanel → *Backup* → *Download a MySQL Database Backup*.
- **`_storage/`** — this holds every recording. Back it up with cPanel's file
  backup, or compress it in File Manager and download it periodically.

`_app/config.local.php` holds your database credentials and the secret used to
sign tokens. Keep it out of any public backup.

---

## Troubleshooting

**"MyLoom is not installed yet"** — `_app/config.local.php` is missing. Re-run
`install.php`. If it was deleted, re-upload it from the package.

**500 Internal Server Error** — check `_storage/logs/php-error.log` in File
Manager. The most common causes are a PHP version below 8.0 and the
`php_value` block in `.htaccess` on a host that forbids it (delete that block).

**Pretty URLs 404, but `/index.php` works** — `mod_rewrite` is off or
`.htaccess` did not upload. The app falls back to `?r=` style API routes
automatically, but page URLs need rewriting. Ask your host to enable
`mod_rewrite` / `AllowOverride All`.

**"Screen recording needs a secure connection"** — the page is on HTTP. Finish
AutoSSL and load the site over `https://`. Also make sure the *Site URL* saved
in the installer starts with `https://`.

**Recording stops after a few minutes** — almost always disk space. cPanel →
*Disk Usage*. Also check the *Maximum recording size* you set during install;
raise it in `_app/config.local.php` (`max_upload_mb`).

**"The storage folder is not writable"** — repeat step 3.

**Video will not play on an iPhone** — Safari cannot play VP8/VP9 WebM. Chrome
and Safari on machines with H.264 record MP4 automatically, but a recording
made in Firefox will be WebM and iOS will not play it. Record in Chrome, Edge
or Safari when your audience is on Apple devices.

**Uploads fail at exactly the same size every time** — a proxy or
mod_security rule is capping request bodies. Lower the chunk size: in
`assets/js/record.js`, pass `chunkMs: 1500` to `ML.Recorder({...})`.

---

## Updating

1. Back up the database and `_storage/`.
2. Upload the new files over the old ones, **keeping** `_app/config.local.php`
   and the `_storage/` folder.
3. If the release notes mention schema changes, import the new
   `database/schema.sql` via phpMyAdmin — every statement uses
   `CREATE TABLE IF NOT EXISTS`, so it is safe to re-run.
