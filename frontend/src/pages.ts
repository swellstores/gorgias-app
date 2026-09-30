function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; color: #171717; background: #fafafa; }
  main { max-width: 520px; margin: 64px auto; padding: 32px; background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  ol { padding-left: 20px; }
  code { background: #f5f5f5; padding: 1px 6px; border-radius: 4px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

// Gorgias sends installs started from its own App Store here with the helpdesk
// subdomain, but nothing identifies the Swell store, so the merchant finishes
// from the Swell dashboard where the store is known.
export function installPage(account: string | null): string {
  const helpdesk = account
    ? ` and enter <code>${escapeHtml(account)}</code>`
    : '';
  return page(
    'Connect Gorgias to Swell',
    `<h1>Connect Gorgias to Swell</h1>
<p>Finish connecting from your Swell dashboard:</p>
<ol>
  <li>Install the Gorgias app from the Swell App Store, if you haven't already.</li>
  <li>In your Swell dashboard, open <strong>Gorgias</strong> in the menu.</li>
  <li>Click <strong>Connect Gorgias</strong>${helpdesk}, then approve access in Gorgias.</li>
</ol>`,
  );
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
