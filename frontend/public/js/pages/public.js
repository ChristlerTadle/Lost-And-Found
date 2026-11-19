import * as shared from '../shared.js';
const { API, sessionInfo, h, param, icon, field, alert } = shared;

async function homePage() {
  return `<main class="landing"><section><p class="eyebrow">Supreme Student Council</p>
    <h1 class="display">Lost something? Help is closer than you think.</h1>
    <p class="hero-copy">The official Bukidnon State University platform for reporting lost or found items, tracking updates, and helping belongings return to their owners.</p>
    <div class="actions"><a class="btn btn-primary btn-lg" href="/?page=login">Get started</a>
      <a class="btn btn-secondary btn-lg" href="/?page=login&amp;tab=register">Create account</a></div></section>
    <section class="feature-panel" aria-label="Lost and found overview"><span class="circle circle-one"></span><span class="circle circle-two"></span><span class="circle circle-three"></span>
      <div class="panel-content"><div><p class="panel-kicker">Your campus lost-and-found, all in one place</p>
        <h2 class="display">Report it, track it, help it find its way home.</h2></div>
        <div class="steps"><div class="step"><div class="step-number">01</div><p class="step-label">Create your account</p></div>
          <div class="step"><div class="step-number">02</div><p class="step-label">Track your reports</p></div></div></div>
    </section></main>`;
}

function loginPage(message = '') {
  const registering = param('tab') === 'register';
  const authError = new URLSearchParams(location.search).get('authError');
  const errorMessage = message || (authError === 'google-unavailable'
    ? 'Google sign-in is temporarily unavailable. Please use email and password.'
    : authError ? 'Google sign-in could not be completed.' : '');
  const accessForm = (isRegister) => `<div class="card card-pad-lg"><form class="form-grid" data-form="${isRegister ? 'register' : 'login'}">
    ${isRegister ? field('Full name', 'full_name', 'text', '', true, 'autocomplete="name"') : ''}
    ${field('Email address', 'email', 'email', '', true, 'autocomplete="email"')}
    ${isRegister ? field('Student ID', 'student_id', 'text', '', true) : ''}
    ${isRegister ? field('Phone number', 'phone', 'tel', '', true, 'inputmode="numeric" pattern="[0-9]*" autocomplete="tel"') : ''}
    ${field('Password', 'password', 'password', '', true, isRegister ? 'minlength="8" autocomplete="new-password"' : 'autocomplete="current-password"')}
    ${isRegister ? '' : `<div class="auth-forgot"><a href="/?page=forgot-password">Forgot password?</a></div>
      ${sessionInfo.googleAuth?.active ? `<div class="auth-divider"><span>or</span></div><a class="btn btn-google btn-block" data-action="google-signin" href="${h(API)}/auth/google"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.15v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 13.04A6.6 6.6 0 0 1 5.5 11c0-.71.12-1.4.34-2.04V6.12H2.15A11 11 0 0 0 1 11c0 1.77.42 3.44 1.15 4.88l3.69-2.84z"/><path fill="#EA4335" d="M12 4.43c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.09 14.97 0 12 0A11 11 0 0 0 2.15 6.12L5.84 8.96C6.71 6.36 9.14 4.43 12 4.43z"/></svg><span>Continue with Google</span></a>` : ''}`}
    ${sessionInfo.recaptcha?.active ? `<div class="g-recaptcha" data-sitekey="${h(sessionInfo.recaptcha.siteKey)}"></div>` : ''}
    <div class="form-actions"><button class="btn btn-primary btn-block" type="submit" ${sessionInfo.recaptcha?.active ? 'disabled' : ''}>${isRegister ? 'Create account' : 'Sign in'}</button></div>
  </form></div>`;
  return `<main class="auth"><section class="auth-side"><span class="auth-circle auth-circle-one"></span>
    <span class="auth-circle auth-circle-two"></span><span class="auth-circle auth-circle-three"></span>
    <div><a class="brand" href="/"><span class="brand-mark">${icon('shield', 24)}</span><span><span class="brand-name">BukSU</span><span class="brand-caption">Lost &amp; Found System</span></span></a>
    <h1 class="display">Helping you reunite with your belongings.</h1>
    <p class="lead">Bukidnon State University's official platform for reporting, tracking, and recovering lost and found items on campus.</p></div>
    <p class="copyright">Supreme Student Council</p></section>
    <section class="auth-main"><div class="auth-box"><div class="auth-mobile-brand brand"><span class="brand-mark">${icon('shield', 20)}</span>
      <span><span class="brand-name">BukSU</span><span class="brand-caption">Lost &amp; Found System</span></span></div>
      <h2>${registering ? 'Create your account' : 'Welcome back'}</h2>
      <p class="sub">${registering ? 'Register your BukSU account to report and track lost or found items.' : 'Sign in with your student or staff account to access your role-specific workspace.'}</p>
      ${errorMessage ? alert(errorMessage, true) : ''}
      <nav class="tabs" aria-label="Account access"><a class="${registering ? '' : 'active'}" href="/?page=login">Sign in</a>
        <a class="${registering ? 'active' : ''}" href="/?page=login&amp;tab=register">Create account</a></nav>
      ${accessForm(registering)}
      <p class="auth-switch">${registering ? 'Already have an account?' : 'Need an account?'}
        <a href="/?page=login${registering ? '' : '&amp;tab=register'}">${registering ? 'Sign in' : 'Register here'}</a></p>
    </div></section></main>`;
}

function authForm(type) {
  const forgot = type === 'forgot';
  const token = param('token');
  const title = forgot ? 'Forgot your password?' : 'Set a new password';
  const subtitle = forgot ? 'Enter your account email and we will send you a password reset link.' : 'Choose a new password for your account.';
  return `<main class="auth"><section class="auth-side"><span class="auth-circle auth-circle-one"></span>
    <span class="auth-circle auth-circle-two"></span><span class="auth-circle auth-circle-three"></span>
    <div><a class="brand" href="/"><span class="brand-mark">${icon('shield', 24)}</span><span><span class="brand-name">BukSU</span><span class="brand-caption">Lost &amp; Found System</span></span></a>
    <h1 class="display">Helping you reunite with your belongings.</h1>
    <p class="lead">Bukidnon State University's official platform for reporting, tracking, and recovering lost or found items on campus.</p></div>
    <p class="copyright">Supreme Student Council</p></section><section class="auth-main"><div class="auth-box">
    <div class="auth-mobile-brand brand"><span class="brand-mark">${icon('shield', 20)}</span><span><span class="brand-name">BukSU</span><span class="brand-caption">Lost &amp; Found System</span></span></div>
    <h2>${title}</h2><p class="sub">${subtitle}</p>
    <div class="card card-pad-lg"><form class="form-grid" data-form="${forgot ? 'forgot' : 'reset'}">
      ${forgot ? field('Email address', 'email', 'email', '', true, 'autocomplete="email"')
    : `${field('New password', 'password', 'password', '', true, 'minlength="8" autocomplete="new-password"')}
      ${field('Confirm new password', 'password_confirmation', 'password', '', true, 'minlength="8" autocomplete="new-password"')}
      <input type="hidden" name="token" value="${h(token)}">`}
      <div class="form-actions"><button class="btn btn-primary btn-block" type="submit">${forgot ? 'Send reset link' : 'Reset password'}</button></div>
    </form></div><p class="auth-switch"><a href="/?page=login">Back to sign in</a>${forgot ? '' : ' · <a href="/?page=forgot-password">Request another link</a>'}</p>
    </div></section></main>`;
}

export { homePage, loginPage, authForm };
