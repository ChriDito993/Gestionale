// Attach the page's session token only to same-origin mutations.
(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
        const isRequest = input instanceof Request;
        const url = new URL(isRequest ? input.url : input, window.location.href);
        const method = String(options?.method || (isRequest ? input.method : 'GET')).toUpperCase();
        if (url.origin !== window.location.origin || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            return originalFetch(input, options);
        }
        const headers = new Headers(options?.headers ?? (isRequest ? input.headers : undefined));
        const token = document.querySelector('meta[name="csrf-token"]')?.content;
        if (token) headers.set('X-CSRF-Token', token);
        return originalFetch(input, { ...options, headers });
    };
})();
