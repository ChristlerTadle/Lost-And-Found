<?php pageStart('Report Lost Item', $user, 'report'); ?>
<main class="container container-md">
	<header class="page-header">
		<div>
			<h1>Report a Lost Item</h1>
			<p>Add accurate details so your report can be reviewed.</p>
		</div>
	</header>
	<?php if ($error): ?><div class="alert alert-error"><?= e($error) ?></div><?php endif; ?>
	<section class="card card-pad-lg">
		<form method="post" action="index.php?page=report&amp;kind=lost" class="form-grid" enctype="multipart/form-data">
			<input type="hidden" name="action" value="report">
			<div class="field"><label for="item_name">Item name</label><input class="input" id="item_name" name="item_name" required></div>
			<div class="field"><label for="category">Category</label><select class="select" id="category" name="category" required><option value="">Select a category</option><?= optionTags(lostCategories()) ?></select></div>
			<div class="field"><label for="location">Location where lost</label><input class="input" id="location" name="location" required></div>
			<div class="field"><label for="date_lost">Date lost</label><input class="input" id="date_lost" name="date_lost" type="date" max="<?= e(date('Y-m-d')) ?>" required></div>
			<div class="field"><label for="description">Description</label><textarea class="textarea" id="description" name="description" required></textarea></div>
			<div class="field"><label for="identifying_details">Identifying details</label><textarea class="textarea" id="identifying_details" name="identifying_details" required></textarea></div>
			<div class="field"><label for="image">Item image <span class="hint">Optional · JPG, PNG, or WEBP up to 5 MB</span></label><input class="input" id="image" name="image" type="file" accept="image/jpeg,image/png,image/webp"></div>
			<div class="form-actions"><button class="btn btn-primary" type="submit">Submit lost report</button></div>
		</form>
	</section>
</main>
<?php pageEnd(); ?>
