document.querySelectorAll('.form__input').forEach(input => {
  input.addEventListener('focus', () => input.closest('.form__group')?.classList.add('focused'));
  input.addEventListener('blur',  () => input.closest('.form__group')?.classList.remove('focused'));
});
document.querySelectorAll('form').forEach(form => {
  form.addEventListener('submit', function() {
    const btn = this.querySelector('button[type="submit"]');
    if (btn) setTimeout(() => { btn.disabled = true; btn.style.opacity = '0.6'; }, 100);
  });
});
