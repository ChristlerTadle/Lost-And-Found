<?php
pageStart('Dashboard', $user, 'dashboard');
$lostCount = count(array_filter($items, static fn (array $item): bool => $item['item_type'] === 'lost'));
$foundCount = count(array_filter($items, static fn (array $item): bool => $item['item_type'] === 'found'));
$pendingClaims = count(array_filter($claims, static fn (array $claim): bool => $claim['status'] === 'pending'));
$activity = [];
foreach ($items as $item) {
	$activity[] = [
		'type' => $item['item_type'],
		'label' => ucfirst($item['item_type']) . ' report submitted',
		'name' => $item['item_name'],
		'date' => $item['created_at'],
	];
}
foreach ($claims as $claim) {
	$activity[] = [
		'type' => 'claim',
		'label' => 'Claim ' . strtolower($claim['status']),
		'name' => $claim['item_name'],
		'date' => $claim['created_at'],
	];
}
usort($activity, static fn (array $left, array $right): int => strcmp((string) $right['date'], (string) $left['date']));
$activity = array_slice($activity, 0, 5);
?>
<main class="container dashboard-page">
	<header class="page-header">
		<div><h1>My Dashboard</h1><p>Welcome back, <?= e($user['full_name']) ?>. Here's your overview.</p></div>
		<div class="head-actions"><a class="btn btn-outline" href="index.php?page=report">Report lost</a><a class="btn btn-primary" href="index.php?page=report&amp;kind=found">Report found</a></div>
	</header>
	<div class="dashboard-stats">
		<a class="card dashboard-stat" href="index.php?page=reports"><span class="dashboard-stat-icon lost"><?= icon('alert', 17) ?></span><span><span class="stat-label">My lost reports</span><strong><?= e($lostCount) ?></strong><small>View my reports</small></span></a>
		<a class="card dashboard-stat" href="index.php?page=reports"><span class="dashboard-stat-icon found"><?= icon('check', 17) ?></span><span><span class="stat-label">Found reports</span><strong><?= e($foundCount) ?></strong><small>Submitted by me</small></span></a>
		<a class="card dashboard-stat" href="index.php?page=claims"><span class="dashboard-stat-icon claim"><?= icon('clipboard', 17) ?></span><span><span class="stat-label">My claims</span><strong><?= e(count($claims)) ?></strong><small><?= e($pendingClaims) ?> pending</small></span></a>
	</div>
	<div class="dashboard-grid">
		<section class="card dashboard-panel"><div class="dashboard-panel-head"><h3>Recent activity</h3><a class="link-sm" href="index.php?page=reports">View reports</a></div><div class="dashboard-activity"><?php if (!$activity): ?><p class="empty">No activity yet.</p><?php endif; ?><?php foreach ($activity as $entry): ?><div class="dashboard-activity-row"><span class="dashboard-activity-icon <?= e($entry['type']) ?>"><?= icon($entry['type'] === 'claim' ? 'clipboard' : ($entry['type'] === 'found' ? 'check' : 'alert'), 15) ?></span><div><strong><?= e($entry['label']) ?></strong><span><?= e($entry['name']) ?></span></div><time datetime="<?= e($entry['date']) ?>"><?= e(formatDate($entry['date'])) ?></time></div><?php endforeach; ?></div></section>
		<aside class="dashboard-side"><section class="card dashboard-panel"><div class="dashboard-panel-head"><h3>Quick actions</h3></div><div class="quick-actions"><a class="quick" href="index.php?page=items"><?= icon('file', 16) ?>Browse lost &amp; found items</a><a class="quick" href="index.php?page=claims"><?= icon('clipboard', 16) ?>Check my claims</a><a class="quick" href="index.php?page=reports"><?= icon('file', 16) ?>Manage my reports</a></div></section></aside>
	</div>
</main>
<?php pageEnd(); ?>