(function () {
  const form = document.getElementById('priorityForm');
  if (!form) return;

  const phone = document.getElementById('phone');
  const email = document.getElementById('email');
  const instagram = document.getElementById('instagramUsername');
  const button = form.querySelector('button[type="submit"]');
  const loading = document.getElementById('priorityLoading');
  const validPhone = (value) =>
    /^\+[1-9]\d{7,14}$/.test(value.replace(/[\s().-]/g, '').replace(/^009/, '+9')) ||
    /^0?5\d{8}$/.test(value.replace(/[\s().-]/g, ''));

  phone.addEventListener('input', () => phone.setCustomValidity(''));
  email.addEventListener('input', () => {
    email.value = email.value.trim().toLowerCase();
  });
  instagram.addEventListener('input', () => {
    instagram.value = instagram.value.replace(/^@+/, '').toLowerCase();
  });

  form.addEventListener('submit', (event) => {
    phone.setCustomValidity(validPhone(phone.value) ? '' : 'Enter a valid phone number with a country code.');
    instagram.setCustomValidity(
      /^[a-zA-Z0-9._]{1,30}$/.test(instagram.value.replace(/^@+/, ''))
        ? ''
        : 'Use letters, numbers, dots, or underscores only.'
    );
    if (!form.checkValidity()) {
      event.preventDefault();
      form.reportValidity();
      return;
    }
    button.disabled = true;
    button.textContent = 'JOINING...';
    loading.textContent = 'Saving your Priority Access request...';
  });
})();
