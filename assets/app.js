(() => {
  document.documentElement.classList.add('js');

  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay');
  const menuButton = document.getElementById('menu-btn');
  const highlightTarget = new URLSearchParams(window.location.search).get('highlight');
  const notificationTargetId = highlightTarget || window.location.hash.slice(1);
  const notificationTarget = notificationTargetId
    ? document.getElementById(notificationTargetId)
    : null;
  if (notificationTarget) {
    notificationTarget.classList.add('notification-highlight');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => notificationTarget.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'center',
    }));
  }

  const toggleMenu = (open) => {
    if (!sidebar || !overlay) return;
    sidebar.classList.toggle('open', open);
    overlay.classList.toggle('show', open);
  };
  menuButton?.addEventListener('click', () => toggleMenu(true));
  overlay?.addEventListener('click', () => toggleMenu(false));

  document.querySelectorAll('[data-tab]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const tab = link.getAttribute('data-tab');
      document.querySelectorAll('.tabs [data-tab]').forEach((tabLink) => {
        tabLink.classList.toggle('active', tabLink.getAttribute('data-tab') === tab);
      });
      document.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.hidden = panel.getAttribute('data-panel') !== tab;
      });
      window.scrollTo(0, 0);
    });
  });

  const profileForm = document.getElementById('profile-form');
  const editButton = document.getElementById('edit-profile');
  if (profileForm) {
    const editable = profileForm.querySelectorAll('[data-editable]');
    const setEditing = (enabled) => {
      editable.forEach((field) => { field.disabled = !enabled; });
      profileForm.classList.toggle('editing', enabled);
      if (editButton) editButton.hidden = enabled;
    };
    setEditing(false);
    editButton?.addEventListener('click', () => setEditing(true));
    document.getElementById('cancel-edit')?.addEventListener('click', (event) => {
      event.preventDefault();
      profileForm.reset();
      setEditing(false);
    });
  }
})();
