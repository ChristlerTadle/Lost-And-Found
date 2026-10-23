<?php pageStart('Browse Items', $user, 'items'); ?>
<main class="container browse-page">
	<header class="page-header">
		<div><h1>Lost &amp; Found Items</h1><p>Browse active records and check whether an item matches.</p></div>
		<div class="head-actions"><a class="btn btn-primary" href="index.php?page=report&amp;kind=found">Report found item</a></div>
	</header>
	<?php if ($error): ?><div class="alert alert-error"><?= e($error) ?></div><?php endif; ?>
	<section class="card card-pad browse-filters">
		<form method="get" action="index.php" class="form-grid">
			<input type="hidden" name="page" value="items">
			<div class="browse-filter-grid">
				<div class="field"><label for="query">Search</label><input class="input" id="query" name="query" value="<?= e($_GET['query'] ?? '') ?>" placeholder="Name, description, or keyword"></div>
				<div class="field"><label for="item_type">Type</label><select class="select" id="item_type" name="item_type"><option value="">All items</option><option value="lost" <?= (($_GET['item_type'] ?? '') === 'lost') ? 'selected' : '' ?>>Lost</option><option value="found" <?= (($_GET['item_type'] ?? '') === 'found') ? 'selected' : '' ?>>Found</option></select></div>
				<div class="field"><label for="category">Category</label><select class="select" id="category" name="category"><option value="">All categories</option><?= optionTags(lostCategories(), (string) ($_GET['category'] ?? '')) ?></select></div>
				<div class="field"><label for="location">Location</label><input class="input" id="location" name="location" value="<?= e($_GET['location'] ?? '') ?>"></div>
				<div class="field"><label for="date_from">Date from</label><input class="input" id="date_from" name="date_from" type="date" value="<?= e($_GET['date_from'] ?? '') ?>"></div>
				<div class="field"><label for="date_to">Date to</label><input class="input" id="date_to" name="date_to" type="date" value="<?= e($_GET['date_to'] ?? '') ?>"></div>
			</div>
			<div class="form-actions end"><a class="button button-secondary" href="index.php?page=items">Clear</a><button class="button button-primary" type="submit">Browse items</button></div>
		</form>
	</section>
	<section class="browse-grid">
		<?php if (!$items): ?><div class="card empty browse-empty">No matching items found.</div><?php endif; ?>
		<?php foreach ($items as $item): ?>
			<?php $isFound = $item['item_type'] === 'found'; ?>
			<article class="card browse-card">
				<div class="browse-card-top"><span class="browse-type <?= $isFound ? 'found' : 'lost' ?>"><?= $isFound ? 'Found' : 'Lost' ?></span></div>
				<?php if (!empty($item['image_path'])): ?><img class="browse-card-image" src="<?= e($item['image_path']) ?>" alt="<?= e($item['item_name']) ?> image"><?php endif; ?>
				<h2><?= e($item['item_name']) ?></h2>
				<p class="browse-description"><?= e($item['description']) ?></p>
				<div class="browse-meta"><span><?= e($item['category']) ?></span><span><?= e($item['location']) ?></span><span><?= e(formatDate($item['date_lost'], 'M j, Y')) ?></span></div>
				<div class="browse-card-footer"><span>By <?= e($item['reported_by']) ?></span><a class="button button-outline" href="index.php?page=item&amp;id=<?= e($item['id']) ?>">View details</a></div>
			</article>
		<?php endforeach; ?>
	</section>
</main>
<?php pageEnd(); ?>
