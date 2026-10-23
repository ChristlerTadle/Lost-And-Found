<?php
$showRegister = (string) ($_GET['tab'] ?? '') === 'register';
pageStart($showRegister ? 'Create Account' : 'Sign In', null, '', true);
?>
<main class="auth">
	<section class="auth-side">
		<span class="auth-circle auth-circle-one"></span>
		<span class="auth-circle auth-circle-two"></span>
		<span class="auth-circle auth-circle-three"></span>
		<div>
			<a class="brand" href="index.php">
				<span class="brand-mark"><?= icon('shield', 24) ?></span>
				<span><span class="brand-name">BukSU</span><span class="brand-caption">Lost &amp; Found System</span></span>
			</a>
			<h1 class="display">Helping you reunite with your belongings.</h1>
			<p class="lead">Bukidnon State University's official platform for reporting, tracking, and recovering lost and found items on campus.</p>
		</div>
		<p class="copyright">Supreme Student Council</p>
	</section>
	<section class="auth-main">
		<div class="auth-box">
			<div class="auth-mobile-brand brand">
				<span class="brand-mark"><?= icon('shield', 20) ?></span>
				<span><span class="brand-name">BukSU</span><span class="brand-caption">Lost &amp; Found System</span></span>
			</div>
			<h2><?= $showRegister ? 'Create your account' : 'Welcome back' ?></h2>
			<p class="sub"><?= $showRegister ? 'Register your BukSU account to report and track lost or found items.' : 'Sign in to manage your lost and found item reports.' ?></p>
			<?php if ($error): ?><div class="alert alert-error"><?= e($error) ?></div><?php endif; ?>
			<nav class="tabs" aria-label="Account access">
				<a href="index.php?page=login" data-tab="login" class="<?= !$showRegister ? 'active' : '' ?>">Sign in</a>
				<a href="index.php?page=login&amp;tab=register" data-tab="register" class="<?= $showRegister ? 'active' : '' ?>">Create account</a>
			</nav>
			<div class="card card-pad-lg" data-panel="login" <?= $showRegister ? 'hidden' : '' ?>>
				<form method="post" action="index.php?page=login" class="form-grid">
					<input type="hidden" name="action" value="login">
					<div class="field"><label for="email">Email address</label><input class="input" id="email" name="email" type="email" required></div>
					<div class="field"><label for="password">Password</label><input class="input" id="password" name="password" type="password" required></div>
					<div class="form-actions"><button class="btn btn-primary btn-block" type="submit">Sign in</button></div>
				</form>
			</div>
			<div class="card card-pad-lg" data-panel="register" <?= !$showRegister ? 'hidden' : '' ?>>
				<form method="post" action="index.php?page=login" class="form-grid">
					<input type="hidden" name="action" value="register">
					<div class="field"><label for="full_name">Full name</label><input class="input" id="full_name" name="full_name" required></div>
					<div class="field"><label for="register_email">Email address</label><input class="input" id="register_email" name="email" type="email" required></div>
					<div class="field"><label for="student_id">Student ID</label><input class="input" id="student_id" name="student_id" required></div>
					<div class="field"><label for="phone">Phone number</label><input class="input" id="phone" name="phone" required></div>
					<div class="field"><label for="register_password">Password</label><input class="input" id="register_password" name="password" type="password" minlength="8" required></div>
					<div class="form-actions"><button class="btn btn-primary btn-block" type="submit">Create account</button></div>
				</form>
			</div>
			<p class="auth-switch"><?= $showRegister ? 'Already have an account?' : 'Need an account?' ?> <a href="<?= $showRegister ? 'index.php?page=login' : 'index.php?page=login&amp;tab=register' ?>" data-tab="<?= $showRegister ? 'login' : 'register' ?>"><?= $showRegister ? 'Sign in' : 'Register here' ?></a></p>
		</div>
	</section>
</main>
<?php pageEnd(); ?>