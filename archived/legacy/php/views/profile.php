<?php
pageStart('Profile', $user, 'profile');
$initial = strtoupper(substr((string) $user['full_name'], 0, 1));
$lostCount = count(array_filter($items, static fn (array $item): bool => $item['item_type'] === 'lost'));
$foundCount = count(array_filter($items, static fn (array $item): bool => $item['item_type'] === 'found'));
?>
<main class="container profile-page">
	<header class="page-header">
		<div><h1>My Profile</h1><p>Manage your account information.</p></div>
		<button class="btn btn-outline edit-toggle" id="edit-profile" type="button"><?= icon('edit', 15) ?> Edit profile</button>
	</header>
	<?php if ($message): ?><div class="alert alert-success"><?= e($message) ?></div><?php endif; ?>
	<?php if ($error): ?><div class="alert alert-error"><?= e($error) ?></div><?php endif; ?>
	<div class="profile-grid">
		<section class="card profile-summary">
			<div class="avatar"><?= e($initial) ?></div>
			<h2><?= e($user['full_name']) ?></h2>
			<span class="pill"><?= e(roleLabel($user['role_name'] ?? null)) ?></span>
			<div class="profile-meta"><p>Student ID: <b><?= e($user['student_id'] ?? 'Not provided') ?></b></p><p>Member since <?= e(formatDate($user['created_at'], 'F Y')) ?></p></div>
		</section>
		<section class="card profile-details">
			<h2>Personal Information</h2>
			<form method="post" action="index.php?page=profile" class="form-grid" id="profile-form">
				<input type="hidden" name="action" value="profile">
				<div class="profile-fields">
					<div class="form-field full"><label for="full_name">Full name</label><input class="input" id="full_name" name="full_name" data-editable value="<?= e($user['full_name']) ?>" required></div>
					<div class="form-field"><label for="email">Email address</label><input class="input" id="email" value="<?= e($user['email']) ?>" disabled></div>
					<div class="form-field"><label for="phone">Phone number</label><input class="input" id="phone" name="phone" data-editable value="<?= e($user['phone'] ?? '') ?>"></div>
					<div class="form-field"><label for="student_id">Student ID</label><input class="input" id="student_id" value="<?= e($user['student_id'] ?? '') ?>" disabled></div>
				</div>
				<div class="form-actions only-edit"><a class="button button-secondary" id="cancel-edit" href="index.php?page=profile">Cancel</a><button class="button button-primary" type="submit">Save changes</button></div>
			</form>
		</section>
	</div>
	<section class="card account-summary"><h2>Account Summary</h2><div class="account-summary-grid"><a href="index.php?page=reports"><strong><?= e($lostCount) ?></strong><span>Lost reports</span></a><a href="index.php?page=reports"><strong><?= e($foundCount) ?></strong><span>Found reports</span></a><a href="index.php?page=claims"><strong><?= e(count($claims)) ?></strong><span>Claims filed</span></a></div></section>
</main>
<?php pageEnd(); ?>
