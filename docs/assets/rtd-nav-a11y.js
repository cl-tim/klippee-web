(() => {
  const enhanceNavigationToggle = () => {
    const toggle = document.querySelector('[data-toggle="wy-nav-top"]');
    const sideNav = document.querySelector('.wy-nav-side');
    if (!toggle || !sideNav) return;

    if (!sideNav.id) sideNav.id = 'klippee-side-nav';
    toggle.setAttribute('role', 'button');
    toggle.setAttribute('tabindex', '0');
    toggle.setAttribute('aria-label', 'Toggle navigation');
    toggle.setAttribute('aria-controls', sideNav.id);

    const syncExpanded = () => {
      toggle.setAttribute('aria-expanded', String(sideNav.classList.contains('shift')));
    };

    syncExpanded();
    new MutationObserver(syncExpanded).observe(sideNav, {
      attributes: true,
      attributeFilter: ['class'],
    });

    toggle.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      toggle.click();
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceNavigationToggle, { once: true });
  } else {
    enhanceNavigationToggle();
  }
})();
