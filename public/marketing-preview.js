(function () {
  const subject = document.getElementById('campaignSubject');
  const body = document.getElementById('campaignBody');
  const sender = document.getElementById('campaignSender');
  const preview = document.getElementById('emailPreview');
  if (!subject || !body || !sender || !preview) return;

  function updatePreview() {
    document.getElementById('previewSubject').textContent = subject.value || 'Your subject';
    document.getElementById('previewBody').textContent = body.value || 'Your message will appear here.';
    document.getElementById('previewSender').textContent = sender.value || 'Asile Events';
  }

  [subject, body, sender].forEach((input) => input.addEventListener('input', updatePreview));
  document.querySelectorAll('.preview-mode').forEach((button) => {
    button.addEventListener('click', () => {
      preview.classList.toggle('mobile-preview', button.dataset.mode === 'mobile');
    });
  });
  updatePreview();
})();
