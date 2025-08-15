document.addEventListener('DOMContentLoaded', () => {

    const preloader = document.getElementById('preloader');
    const mainContent = document.getElementById('main-content');
    
    window.addEventListener('load', () => {
        preloader.style.opacity = '0';
        preloader.addEventListener('transitionend', () => preloader.style.display = 'none');
        mainContent.style.opacity = '1';
    });

    const domain = `${window.location.protocol}//${window.location.host}`;
    document.querySelectorAll('.dynamic-domain').forEach(el => {
        el.textContent = domain;
    });

    document.querySelectorAll('.copy-btn').forEach(button => {
        button.addEventListener('click', () => {
            const pre = button.previousElementSibling;
            const code = pre.querySelector('code');
            const textToCopy = code.innerText;

            navigator.clipboard.writeText(textToCopy).then(() => {
                button.textContent = 'COPIED!';
                button.classList.add('copied');
                setTimeout(() => {
                    button.textContent = 'COPY';
                    button.classList.remove('copied');
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy text: ', err);
                button.textContent = 'ERROR';
                 setTimeout(() => {
                    button.textContent = 'COPY';
                }, 2000);
            });
        });
    });
});