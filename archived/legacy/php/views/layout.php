<?php

declare(strict_types=1);

/* ---------- Shared data ---------- */

function lostCategories(): array
{
    return [
        'Electronics & Gadgets', 'Personal Accessories', 'Clothing & Accessories', 'Bags & Luggage',
        'Documents & IDs', 'Personal Items', 'Books & School Supplies', 'Sports Equipment', 'Other',
    ];
}

function campusLocations(): array
{
    return [
        'Main Library', 'Main Library – 2nd Floor Reading Area', 'Engineering Building',
        'Engineering Building – Room 204', 'College of Arts and Sciences – Lobby',
        'University Canteen – Main Building', 'College Computer Laboratory – Room 101',
        'Gymnasium – Bleacher Area', 'Administration Building – Corridor',
        'College of Nursing – Simulation Room', 'College of Education – Room 302',
        "Registrar's Office – Waiting Area", 'Student Affairs Office', 'Science Building',
        'University Oval', 'Covered Court', 'Dormitory Area', 'Chapel', 'Parking Lot', 'Other',
    ];
}

/* ---------- Helpers ---------- */

/** Builds <option> tags. A saved value that is not in the list is kept as an extra option. */
function optionTags(array $list, ?string $selected = null, ?string $placeholder = null): string
{
    $html = '';
    if ($placeholder !== null) {
        $html .= '<option value="">' . e($placeholder) . '</option>';
    }
    if ($selected !== null && $selected !== '' && !in_array($selected, $list, true)) {
        $list[] = $selected;
    }
    foreach ($list as $option) {
        $isSelected = ($selected !== null && $option === $selected) ? ' selected' : '';
        $html .= '<option value="' . e($option) . '"' . $isSelected . '>' . e($option) . '</option>';
    }
    return $html;
}

function formatDate($value, string $format = 'M j, Y'): string
{
    $time = strtotime((string) $value);
    return $time === false ? '' : date($format, $time);
}

function icon(string $name, int $size = 17): string
{
    $paths = [
        'home' => '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
        'alert' => '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
        'file' => '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
        'user' => '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        'check' => '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        'clipboard' => '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
        'shield' => '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
        'menu' => '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
        'edit' => '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
        'x' => '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    ];
    return '<svg width="' . $size . '" height="' . $size . '" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        . 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        . ($paths[$name] ?? '') . '</svg>';
}

function roleLabel(?string $role): string
{
    $labels = ['user' => 'Student', 'staff' => 'Staff', 'admin' => 'Administrator'];
    return $labels[$role ?? ''] ?? 'Member';
}

/* ---------- Page shell ---------- */

/**
 * $user   – logged-in user (shows the sidebar layout) or null for public pages.
 * $active – sidebar key: dashboard | report | reports | profile
 * $bare   – true for full-screen pages such as login (no header/sidebar).
 */
function pageStart(string $title, ?array $user = null, string $active = '', bool $bare = false): void
{
    $mode = $bare ? 'bare' : ($user ? 'app' : 'public');
    $GLOBALS['layoutMode'] = $mode;
    $scriptDirectory = str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/')));
    $assetBase = rtrim($scriptDirectory === '/' ? '' : $scriptDirectory, '/');

    $nav = [
        ['key' => 'dashboard', 'label' => 'Dashboard', 'href' => 'index.php?page=dashboard', 'icon' => 'home'],
        ['key' => 'report', 'label' => 'Report Lost Item', 'href' => 'index.php?page=report', 'icon' => 'alert'],
        ['key' => 'report-found', 'label' => 'Report Found Item', 'href' => 'index.php?page=report&kind=found', 'icon' => 'check'],
        ['key' => 'items', 'label' => 'Browse Items', 'href' => 'index.php?page=items', 'icon' => 'file'],
        ['key' => 'reports', 'label' => 'My Reports', 'href' => 'index.php?page=reports', 'icon' => 'file'],
        ['key' => 'claims', 'label' => 'My Claims', 'href' => 'index.php?page=claims', 'icon' => 'check'],
        ['key' => 'profile', 'label' => 'Profile', 'href' => 'index.php?page=profile', 'icon' => 'user'],
    ];
    $name = (string) ($user['full_name'] ?? '');
    $initial = strtoupper(substr($name, 0, 1));
    $role = roleLabel($user['role_name'] ?? null);
    ?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= e($title) ?> - BukSU Lost &amp; Found</title>
<link rel="stylesheet" href="<?= e($assetBase . '/assets/app.css?v=' . filemtime(__DIR__ . '/../assets/app.css')) ?>">
</head>
<body>
<?php if ($mode === 'public'): ?>
<header class="site-header">
    <a class="brand" href="index.php">
        <span class="brand-mark"><?= icon('shield', 22) ?></span>
        <span><span class="brand-name">BukSU</span><span class="brand-caption">Lost &amp; Found System</span></span>
    </a>
    <a class="btn btn-outline" href="index.php?page=login">Sign In</a>
</header>
<?php elseif ($mode === 'app'): ?>
<div class="app">
    <aside class="sidebar" id="sidebar">
        <a class="sidebar-brand" href="index.php?page=dashboard">
            <span class="brand-mark"><?= icon('shield', 22) ?></span>
            <span><span class="brand-name">BukSU</span><span class="brand-caption">Lost &amp; Found System</span></span>
        </a>
        <nav class="sidebar-nav">
            <p class="sidebar-label">Navigation</p>
            <?php foreach ($nav as $item): ?>
                <a class="sidebar-link<?= $active === $item['key'] ? ' active' : '' ?>" href="<?= e($item['href']) ?>">
                    <?= icon($item['icon']) ?><?= e($item['label']) ?>
                </a>
            <?php endforeach; ?>
        </nav>
        <div class="sidebar-user">
            <div class="avatar-sm"><?= e($initial) ?></div>
            <div>
                <p class="sidebar-user-name"><?= e($name) ?></p>
                <p class="sidebar-user-role"><?= e($role) ?></p>
            </div>
        </div>
    </aside>
    <div class="overlay" id="overlay"></div>
    <div class="main-col">
        <header class="app-topbar">
            <button class="menu-btn" id="menu-btn" type="button" aria-label="Open menu"><?= icon('menu', 20) ?></button>
            <p class="topbar-title">Bukidnon State University — Supreme Student Council</p>
            <a class="topbar-user" href="index.php?page=profile">
                <span class="avatar-sm"><?= e($initial) ?></span>
                <span class="meta">
                    <span class="name" style="display:block"><?= e($name) ?></span>
                    <span class="role"><?= e($role) ?></span>
                </span>
            </a>
            <a class="signout" href="index.php?logout=1">Sign Out</a>
        </header>
        <main class="content">
<?php endif;
}

function pageEnd(): void
{
    $mode = $GLOBALS['layoutMode'] ?? 'public';
    if ($mode === 'app') {
        echo '</main></div></div>';
    }
    ?>
<script>
(function () {
    var d = document;
    d.documentElement.classList.add('js');

    /* Mobile sidebar */
    var sidebar = d.getElementById('sidebar'), overlay = d.getElementById('overlay'), menuBtn = d.getElementById('menu-btn');
    function toggleMenu(open) {
        if (!sidebar) { return; }
        sidebar.classList.toggle('open', open);
        overlay.classList.toggle('show', open);
    }
    if (menuBtn) { menuBtn.addEventListener('click', function () { toggleMenu(true); }); }
    if (overlay) { overlay.addEventListener('click', function () { toggleMenu(false); }); }

    /* Sign in / Register tabs */
    var tabLinks = d.querySelectorAll('[data-tab]');
    Array.prototype.forEach.call(tabLinks, function (link) {
        link.addEventListener('click', function (ev) {
            ev.preventDefault();
            var name = link.getAttribute('data-tab');
            Array.prototype.forEach.call(d.querySelectorAll('.tabs a'), function (t) {
                t.classList.toggle('active', t.getAttribute('data-tab') === name);
            });
            Array.prototype.forEach.call(d.querySelectorAll('[data-panel]'), function (p) {
                p.hidden = p.getAttribute('data-panel') !== name;
            });
            window.scrollTo(0, 0);
        });
    });

    /* Confirm password on the register form */
    var rp = d.getElementById('register_password'), cp = d.getElementById('confirm_password');
    if (rp && cp) {
        var check = function () { cp.setCustomValidity(cp.value !== rp.value ? 'Passwords do not match.' : ''); };
        rp.addEventListener('input', check);
        cp.addEventListener('input', check);
    }

    /* Profile: view / edit toggle */
    var pf = d.getElementById('profile-form'), editBtn = d.getElementById('edit-profile');
    if (pf) {
        var editable = pf.querySelectorAll('[data-editable]');
        var setEdit = function (on) {
            Array.prototype.forEach.call(editable, function (el) { el.disabled = !on; });
            pf.classList.toggle('editing', on);
            if (editBtn) { editBtn.hidden = on; }
        };
        setEdit(false);
        if (editBtn) { editBtn.addEventListener('click', function () { setEdit(true); }); }
        var cancel = d.getElementById('cancel-edit');
        if (cancel) { cancel.addEventListener('click', function () { pf.reset(); setEdit(false); }); }
    }

    /* Report form: 3-step wizard */
    var form = d.getElementById('report-form');
    if (form) {
        var steps = form.querySelectorAll('[data-step]');
        var items = d.querySelectorAll('.stepper-item'), lines = d.querySelectorAll('.stepper-line');
        var prev = d.getElementById('btn-prev'), next = d.getElementById('btn-next'), submit = d.getElementById('btn-submit');
        var current = 1;
        var show = function (n) {
            current = n;
            Array.prototype.forEach.call(steps, function (s) { s.hidden = Number(s.getAttribute('data-step')) !== n; });
            Array.prototype.forEach.call(items, function (it, i) {
                it.classList.toggle('current', i + 1 === n);
                it.classList.toggle('done', i + 1 < n);
                it.querySelector('.dot').textContent = i + 1 < n ? '✓' : String(i + 1);
            });
            Array.prototype.forEach.call(lines, function (ln, i) { ln.classList.toggle('done', i + 1 < n); });
            prev.hidden = n === 1;
            next.hidden = n === 3;
            submit.hidden = n !== 3;
            if (n === 3) {
                Array.prototype.forEach.call(d.querySelectorAll('[data-review]'), function (el) {
                    var field = form.elements[el.getAttribute('data-review')];
                    el.textContent = field && field.value ? field.value : '—';
                });
            }
        };
        next.addEventListener('click', function () {
            var fields = form.querySelectorAll('[data-step="' + current + '"] input, [data-step="' + current + '"] select, [data-step="' + current + '"] textarea');
            for (var i = 0; i < fields.length; i++) {
                if (!fields[i].checkValidity()) { fields[i].reportValidity(); return; }
            }
            show(current + 1);
            window.scrollTo(0, 0);
        });
        prev.addEventListener('click', function () { show(current - 1); });
        show(1);
    }
})();
</script>
</body>
</html>
<?php
}