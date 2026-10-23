<?php pageStart('Report Found Item', $user, 'report-found'); ?>
<main class="container container-md">
	<header class="page-header">
		<div>
			<h1>Report a Found Item</h1>
			<p>Add accurate details so the item can be returned to its owner.</p>
		</div>
	</header>
	<?php if ($error): ?><div class="alert alert-error"><?= e($error) ?></div><?php endif; ?>
	<section class="card card-pad-lg">
		<form method="post" action="index.php?page=report&amp;kind=found" class="form-grid">
			<input type="hidden" name="action" value="report">
			<div class="field"><label for="item_name">Item name</label><input class="input" id="item_name" name="item_name" required></div>
			<div class="field"><label for="category">Category</label><select class="select" id="category" name="category" required><option value="">Select a category</option><?= optionTags(lostCategories()) ?></select></div>
			<div class="field"><label for="location">Location where found</label><input class="input" id="location" name="location" required></div>
			<div class="field"><label for="date_lost">Date found</label><input class="input" id="date_lost" name="date_lost" type="date" max="<?= e(date('Y-m-d')) ?>" required></div>
			<div class="field"><label for="description">Description</label><textarea class="textarea" id="description" name="description" required></textarea></div>
			<div class="field"><label for="identifying_details">Identifying details</label><textarea class="textarea" id="identifying_details" name="identifying_details" required></textarea></div>
			<div class="form-actions"><button class="btn btn-primary" type="submit">Submit found report</button></div>
		</form>
	</section>
</main>
<?php pageEnd(); ?>
