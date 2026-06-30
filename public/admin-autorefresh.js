(function () {
  const intervalMs = 30000;
  const idleMs = 4000;
  let lastInteraction = Date.now();

  function activeFormField() {
    const el = document.activeElement;
    return el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  }

  function markInteraction() {
    lastInteraction = Date.now();
  }

  ['keydown', 'input', 'change', 'pointerdown', 'touchstart'].forEach(eventName => {
    document.addEventListener(eventName, markInteraction, { passive: true });
  });

  window.setInterval(() => {
    if (document.hidden) return;
    if (activeFormField()) return;
    if (Date.now() - lastInteraction < idleMs) return;
    window.location.reload();
  }, intervalMs);

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const button = form.querySelector('button[type="submit"], button:not([type])');
    if (!button || button.disabled) return;
    button.dataset.originalText = button.textContent;
    button.textContent = 'Working...';
    button.disabled = true;
  });
})();
