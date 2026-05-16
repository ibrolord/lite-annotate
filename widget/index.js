(function () {
  const API_URL = window.ANNOTATE_API_URL || 'http://localhost:3001';
  const logs = [];

  // Intercept console logs
  ['log', 'warn', 'error'].forEach((level) => {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      logs.push({ level, msg: args.map(String).join(' '), ts: Date.now() });
      orig(...args);
    };
  });

  function el(tag, styles, attrs) {
    const e = document.createElement(tag);
    if (styles) e.style.cssText = styles;
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'placeholder') e.placeholder = v;
      else if (k === 'rows') e.rows = v;
      else e[k] = v;
    });
    return e;
  }

  // Inject button
  const btn = el('button', [
    'position:fixed', 'bottom:24px', 'right:24px', 'z-index:99999',
    'width:48px', 'height:48px', 'border-radius:50%',
    'background:#000', 'color:#fff', 'border:none',
    'cursor:pointer', 'font-size:22px',
    'box-shadow:0 4px 12px rgba(0,0,0,0.3)',
  ].join(';'));
  btn.textContent = '🐛';
  document.body.appendChild(btn);

  let popover = null;

  btn.addEventListener('click', () => {
    if (popover) { popover.remove(); popover = null; return; }

    popover = el('div', [
      'position:fixed', 'bottom:84px', 'right:24px', 'z-index:99999',
      'background:#fff', 'border:1px solid #e5e7eb', 'border-radius:12px',
      'padding:20px', 'width:300px',
      'box-shadow:0 8px 24px rgba(0,0,0,0.12)',
      'font-family:system-ui,sans-serif',
    ].join(';'));

    const heading = el('div', 'font-weight:600;font-size:15px;margin-bottom:12px;');
    heading.textContent = 'Report a Bug';

    const titleInput = el('input',
      'width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;box-sizing:border-box;margin-bottom:10px;',
      { placeholder: "What's broken?" }
    );

    const descInput = el('textarea',
      'width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;box-sizing:border-box;resize:none;margin-bottom:12px;',
      { placeholder: 'Any extra details...', rows: 3 }
    );

    const submitBtn = el('button',
      'width:100%;padding:10px;background:#000;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:500;'
    );
    submitBtn.textContent = 'Submit Report';

    const status = el('div', 'margin-top:8px;font-size:13px;color:#6b7280;text-align:center;');

    popover.appendChild(heading);
    popover.appendChild(titleInput);
    popover.appendChild(descInput);
    popover.appendChild(submitBtn);
    popover.appendChild(status);
    document.body.appendChild(popover);

    submitBtn.addEventListener('click', async () => {
      const title = titleInput.value.trim();
      if (!title) { status.textContent = 'Please enter a title.'; return; }

      status.textContent = 'Capturing...';
      submitBtn.disabled = true;

      let screenshot = null;
      try {
        if (window.html2canvas) {
          const canvas = await html2canvas(document.body, { useCORS: true, logging: false });
          screenshot = canvas.toDataURL('image/png');
        }
      } catch (e) {
        console.warn('Screenshot failed:', e.message);
      }

      try {
        await fetch(`${API_URL}/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            description: descInput.value.trim(),
            url: window.location.href,
            userAgent: navigator.userAgent,
            consoleLogs: logs.slice(-50),
            screenshot,
          }),
        });

        status.textContent = '✓ Report submitted — fix on the way';
        setTimeout(() => { popover?.remove(); popover = null; }, 2000);
      } catch {
        status.textContent = 'Failed to submit. Is the API running?';
        submitBtn.disabled = false;
      }
    });
  });
})();
