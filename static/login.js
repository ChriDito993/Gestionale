(() => {
    const password = document.getElementById('loginPassword');
    const toggle = document.getElementById('loginPasswordToggle');
    if (password && toggle) {
        toggle.hidden = false;
        toggle.addEventListener('click', () => {
            const show = password.type === 'password';
            password.type = show ? 'text' : 'password';
            toggle.setAttribute('aria-pressed', String(show));
            toggle.setAttribute('aria-label', show ? 'Nascondi password' : 'Mostra password');
        });
    }
    // A failed login stays readable even when the mobile page is scrolled.
    document.getElementById('loginError')?.focus();
})();
