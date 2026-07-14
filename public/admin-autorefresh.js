(function () {
  const intervalMs = 60000;
  const idleMs = 4000;
  const paymentSyncMs = 30000;
  let lastInteraction = Date.now();
  let syncingPayments = false;

  function activeFormField() {
    const el = document.activeElement;
    return el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  }

  function markInteraction() {
    lastInteraction = Date.now();
  }

  ['keydown', 'input', 'change', 'pointerdown', 'touchstart'].forEach((eventName) => {
    document.addEventListener(eventName, markInteraction, { passive: true });
  });

  window.setInterval(() => {
    if (document.hidden) return;
    if (activeFormField()) return;
    if (Date.now() - lastInteraction < idleMs) return;
    window.location.reload();
  }, intervalMs);

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const button = form.querySelector('button[type="submit"], button:not([type])');
    if (!button || button.disabled) return;
    button.dataset.originalText = button.textContent;
    button.textContent = 'Working...';
    button.disabled = true;
  });

  async function syncPaymentsQuietly() {
    const dashboard = document.querySelector('[data-admin-dashboard="true"]');
    if (!dashboard || syncingPayments || document.hidden) return;
    const awaitingCount = Number(dashboard.dataset.awaitingPayments || 0);
    if (!awaitingCount) return;
    syncingPayments = true;
    try {
      const response = await fetch('/admin/orders/sync-payments.json', {
        method: 'POST',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) return;
      const result = await response.json();
      if (result.synced > 0) {
        window.location.href = `/admin?notice=${encodeURIComponent(`Auto-synced ${result.synced} payment(s).`)}`;
        return;
      }
      const notice = document.getElementById('adminNotice');
      if (notice && result.checked > 0) {
        notice.textContent = `Checked ${result.checked} waiting payment(s). Nothing new yet.`;
        notice.classList.remove('hidden');
      }
    } catch (err) {
      console.error('Auto payment sync failed:', err);
    } finally {
      syncingPayments = false;
    }
  }

  window.setTimeout(syncPaymentsQuietly, 1000);
  window.setInterval(syncPaymentsQuietly, paymentSyncMs);
})();
