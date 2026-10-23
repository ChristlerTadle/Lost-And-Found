<?php
pageStart('Item Details', $user, 'items');
$isFound = $item['item_type'] === 'found';
$canClaim = $isFound && (string) $item['user_id'] !== (string) $user['id'] && empty($item['user_claim_id']);
?>
<main class="container item-page">
	<a class="back-link" href="index.php?page=items">&larr; Back to Browse</a>
	<div class="item-page-grid">
		<section class="card item-detail-card">
			<div class="item-detail-top"><span class="type-banner <?= $isFound ? 'found' : 'lost' ?>"><?= $isFound ? 'Found item report' : 'Lost item report' ?></span></div>
			<h1><?= e($item['item_name']) ?></h1>
			<div class="item-detail-meta"><div><small>Category</small><span><?= e($item['category']) ?></span></div><div><small>Location</small><span><?= e($item['location']) ?></span></div><div><small>Date</small><span><?= e(formatDate($item['date_lost'], 'F j, Y')) ?></span></div></div>
			<div class="item-detail-description"><h2>Description</h2><?php if (!empty($item['image_path'])): ?><img class="item-detail-image" src="<?= e($item['image_path']) ?>" alt="<?= e($item['item_name']) ?> image"><?php endif; ?><p><?= e($item['description']) ?></p></div>
			<?php if ($canClaim): ?><div class="item-detail-actions"><a class="button button-primary" href="index.php?page=claim&amp;item=<?= e($item['id']) ?>">Claim item</a></div><?php elseif (!empty($item['user_claim_id'])): ?><div class="alert alert-success">Claim submitted. Staff will review your ownership details.</div><?php elseif ((string) $item['user_id'] === (string) $user['id']): ?><div class="alert alert-success">This is your report.</div><?php endif; ?>
		</section>
		<aside class="item-page-side">
			<section class="card item-info-card"><h2>Report Info</h2><dl><dt>Reported by</dt><dd><?= e($item['reported_by']) ?></dd><dt>Report ID</dt><dd><?= e($item['id']) ?></dd><dt>Total claims</dt><dd><?= e($item['total_claims']) ?></dd></dl></section>
			<section class="card item-notice"><h2>Notice</h2><p>Only the written description is shown publicly. Identifying details are kept private so staff can verify ownership and reduce false claims.</p></section>
		</aside>
	</div>
</main>
<?php pageEnd(); ?>
