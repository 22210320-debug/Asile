(function () {
  const form = document.getElementById('ticketForm');
  if (!form) return;

  const priceCents = Number(form.dataset.ticketPrice || 0);
  const minAge = Number(form.dataset.minAge || 18);
  const eventDate = new Date(form.dataset.eventDate);
  const quantity = document.getElementById('quantity');
  const attendeeForms = document.getElementById('attendeeForms');
  const total = document.getElementById('total');
  const duplicateWarning = document.getElementById('duplicateWarning');
  const quantityWarning = document.getElementById('quantityWarning');
  const ageWarning = document.getElementById('ageWarning');
  const checkoutStatus = document.getElementById('checkoutStatus');
  const reserveSubmit = form.querySelector('.reserve-submit');

  function safeName(value) {
    const name = String(value ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    return /(^|\s)(undefined|null|n\/a|na|unknown)(\s|$)/i.test(name) ? '' : name;
  }

  function formatMoney(cents) {
    return `${(cents / 100).toFixed(0)} NIS`;
  }

  function quantityError() {
    const value = quantity.value.trim();
    if (!value) return 'Cannot order 0 tickets. Please order at least 1.';

    const raw = Number(value);
    if (!Number.isFinite(raw) || raw < 1) return 'Cannot order 0 tickets. Please order at least 1.';
    if (!Number.isInteger(raw)) return 'Please enter a whole number of tickets.';
    if (raw > 10) return 'Cannot order more than 10 tickets at once.';
    return '';
  }

  function quantityForForms() {
    const raw = Number(quantity.value.trim() || 0);
    if (!Number.isFinite(raw) || raw < 1) return 1;
    return Math.min(10, Math.floor(raw));
  }

  function attendeeValues() {
    return [...document.querySelectorAll('.attendee-box')].map((box) => ({
      firstName: safeName(box.querySelector('.attendee-first-name')?.value),
      lastName: safeName(box.querySelector('.attendee-last-name')?.value),
      dob: box.querySelector('.attendee-dob')?.value || '',
      gender: box.querySelector('.attendee-gender')?.value || ''
    }));
  }

  function renderForms() {
    const previous = attendeeValues();
    const qty = quantityForForms();
    attendeeForms.replaceChildren();
    const fragment = document.createDocumentFragment();

    for (let index = 1; index <= qty; index += 1) {
      const saved = previous[index - 1] || {};
      const attendee = document.createElement('div');
      attendee.className = 'attendee-box';
      attendee.innerHTML = `
        <h3>Ticket ${index}</h3>
        <div class="name-grid">
          <label>First name<input name="attendeeFirstName" class="attendee-first-name attendee-name-part" required autocomplete="given-name" placeholder="First name"></label>
          <label>Last name<input name="attendeeLastName" class="attendee-last-name attendee-name-part" required autocomplete="family-name" placeholder="Last name"></label>
        </div>
        <label>Date of birth <span class="hint">DD/MM/YYYY</span><input type="text" name="attendeeDob" class="attendee-dob" required inputmode="numeric" autocomplete="bday" maxlength="10" pattern="\\d{2}/\\d{2}/\\d{4}" placeholder="DD/MM/YYYY"></label>
        <p class="age-result muted"></p>
        <label>Gender<select name="attendeeGender" class="attendee-gender" required><option value="">Select gender</option><option value="female">Female</option><option value="male">Male</option></select></label>`;
      attendee.querySelector('.attendee-first-name').value = safeName(saved.firstName);
      attendee.querySelector('.attendee-last-name').value = safeName(saved.lastName);
      attendee.querySelector('.attendee-dob').value = String(saved.dob || '');
      attendee.querySelector('.attendee-gender').value = String(saved.gender || '');
      fragment.appendChild(attendee);
    }

    attendeeForms.appendChild(fragment);
    total.textContent = formatMoney(priceCents * qty);
    validateForm();
  }

  function parseDob(value) {
    const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return null;

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const dob = new Date(year, month - 1, day);
    if (
      dob.getFullYear() !== year ||
      dob.getMonth() !== month - 1 ||
      dob.getDate() !== day ||
      dob > eventDate
    )
      return null;
    return dob;
  }

  function calculateAge(value) {
    const dob = parseDob(value);
    if (!dob) return null;

    let age = eventDate.getFullYear() - dob.getFullYear();
    const monthDiff = eventDate.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && eventDate.getDate() < dob.getDate())) age -= 1;
    return age;
  }

  function formatDobInput(input) {
    const digits = input.value.replace(/\D/g, '').slice(0, 8);
    if (digits.length > 4) input.value = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    else if (digits.length > 2) input.value = `${digits.slice(0, 2)}/${digits.slice(2)}`;
    else input.value = digits;
  }

  function validateForm() {
    const qtyError = quantityError();
    quantityWarning.textContent = qtyError;
    quantityWarning.classList.toggle('hidden', !qtyError);

    const boxes = [...document.querySelectorAll('.attendee-box')];
    const names = boxes
      .map((box) =>
        `${safeName(box.querySelector('.attendee-first-name')?.value)} ${safeName(box.querySelector('.attendee-last-name')?.value)}`
          .trim()
          .toLowerCase()
          .replace(/\s+/g, ' ')
      )
      .filter(Boolean);
    const hasDuplicates = new Set(names).size !== names.length;
    duplicateWarning.classList.toggle('hidden', !hasDuplicates);

    let underAge = false;
    boxes.forEach((box) => {
      const dobInput = box.querySelector('.attendee-dob');
      const output = box.querySelector('.age-result');
      const age = calculateAge(dobInput.value);
      if (!dobInput.value) {
        output.textContent = '';
        return;
      }
      if (dobInput.value.length < 10 || age === null || age < minAge) {
        underAge = true;
        output.textContent =
          dobInput.value.length < 10
            ? 'Enter date as DD/MM/YYYY.'
            : `Not eligible - attendee must be ${minAge}+ on event day.`;
        output.className = 'age-result bad';
        return;
      }
      output.textContent = `Age on event day: ${age}. Eligible.`;
      output.className = 'age-result good';
    });

    ageWarning.classList.toggle('hidden', !underAge);
    return !qtyError && !hasDuplicates && !underAge;
  }

  quantity.addEventListener('input', renderForms);
  document.addEventListener('input', (event) => {
    if (event.target.matches('.attendee-dob')) formatDobInput(event.target);
    if (event.target.matches('.attendee-name-part')) event.target.value = safeName(event.target.value);
    if (event.target.matches('.attendee-name-part, .attendee-dob, .attendee-gender')) validateForm();
  });

  form.addEventListener('submit', (event) => {
    if (!validateForm()) {
      event.preventDefault();
      return;
    }
    reserveSubmit.disabled = true;
    reserveSubmit.textContent = 'Opening secure payment...';
    checkoutStatus.textContent = 'Opening secure payment. Please do not close this page.';
    checkoutStatus.classList.remove('hidden');
    window.setTimeout(() => {
      if (document.visibilityState === 'visible') {
        checkoutStatus.textContent =
          'Still opening checkout. If this stays here, refresh and try again, or contact us on WhatsApp.';
        reserveSubmit.disabled = false;
        reserveSubmit.textContent = 'Try again';
      }
    }, 15000);
  });

  renderForms();
})();
