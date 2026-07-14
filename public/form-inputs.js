(function () {
  function formatDateOfBirth(input) {
    const digits = input.value.replace(/\D/g, '').slice(0, 8);
    if (digits.length > 4) input.value = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    else if (digits.length > 2) input.value = `${digits.slice(0, 2)}/${digits.slice(2)}`;
    else input.value = digits;
  }

  document.addEventListener('input', (event) => {
    if (event.target.matches('[data-date-format="ddmmyyyy"]')) formatDateOfBirth(event.target);
  });
})();
