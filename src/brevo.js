const BREVO_TRANSACTIONAL_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_NOTIFICATION_EMAIL = 'khalilnahhatdj@gmail.com';

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatCad(value) {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }).format(Number(value || 0));
}

async function sendBrevoEmail(payload) {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  const senderEmail = process.env.EMAIL_FROM_ADDRESS?.trim();

  if (!apiKey || !senderEmail) {
    console.warn('Brevo notification skipped: BREVO_API_KEY or EMAIL_FROM_ADDRESS is missing.');
    return { sent: false, skipped: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(BREVO_TRANSACTIONAL_EMAIL_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: {
          name: process.env.EMAIL_FROM_NAME?.trim() || 'Khalil Nahhat Website',
          email: senderEmail,
        },
        ...payload,
      }),
      signal: controller.signal,
    });

    const responseBody = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(responseBody.message || `Brevo request failed with status ${response.status}.`);
    }

    return { sent: true, messageId: responseBody.messageId || '' };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendServiceRequestNotification(serviceRequest) {
  const recipientEmail = process.env.SERVICE_REQUEST_NOTIFICATION_EMAIL?.trim()
    || DEFAULT_NOTIFICATION_EMAIL;
  const adminServicesUrl = process.env.ADMIN_SERVICES_URL?.trim();
  const itemRows = serviceRequest.items.map((item) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #292929;color:#f4f1ed;">${escapeHtml(item.name)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #292929;color:#b8b3ad;">${escapeHtml(item.category)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #292929;color:#f4f1ed;text-align:center;">${item.quantity}</td>
    </tr>
  `).join('');
  return sendBrevoEmail({
    to: [{ email: recipientEmail, name: 'Khalil Nahhat' }],
    replyTo: {
      email: serviceRequest.customerEmail,
      name: serviceRequest.customerName,
    },
    subject: `New service request from ${serviceRequest.customerName}`,
    tags: ['service-request'],
    htmlContent: `<!doctype html>
      <html>
        <body style="margin:0;background:#080808;color:#f4f1ed;font-family:Arial,sans-serif;">
          <div style="max-width:680px;margin:0 auto;padding:32px 20px;">
            <p style="margin:0 0 8px;color:#ef3939;font-size:12px;letter-spacing:2px;">KN// SERVICE REQUEST</p>
            <h1 style="margin:0 0 24px;font-size:30px;">New quote request</h1>
            <div style="padding:18px;background:#121212;border:1px solid #292929;">
              <p style="margin:0 0 8px;"><strong>Customer:</strong> ${escapeHtml(serviceRequest.customerName)}</p>
              <p style="margin:0 0 8px;"><strong>Username:</strong> ${escapeHtml(serviceRequest.customerUsername)}</p>
              <p style="margin:0 0 8px;"><strong>Email:</strong> ${escapeHtml(serviceRequest.customerEmail)}</p>
              <p style="margin:0;"><strong>Request:</strong> ${escapeHtml(serviceRequest.externalId)}</p>
            </div>
            <table style="width:100%;margin-top:18px;border-collapse:collapse;background:#121212;border:1px solid #292929;">
              <thead>
                <tr>
                  <th style="padding:10px 12px;text-align:left;color:#ef3939;">Service</th>
                  <th style="padding:10px 12px;text-align:left;color:#ef3939;">Category</th>
                  <th style="padding:10px 12px;text-align:center;color:#ef3939;">Qty</th>
                </tr>
              </thead>
              <tbody>${itemRows}</tbody>
            </table>
            ${adminServicesUrl ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(adminServicesUrl)}" style="display:inline-block;padding:12px 18px;background:#c12a32;color:#fff;text-decoration:none;">Open Services Control</a></p>` : ''}
          </div>
        </body>
      </html>`,
  });
}

async function sendServiceQuoteNotification(serviceRequest) {
  const khalilEmail = process.env.SERVICE_REQUEST_NOTIFICATION_EMAIL?.trim()
    || DEFAULT_NOTIFICATION_EMAIL;
  const customerServicesUrl = process.env.CUSTOMER_SERVICES_URL?.trim();
  const total = serviceRequest.items.reduce(
    (sum, item) => sum + Number(item.unitPrice || 0) * item.quantity,
    0,
  );
  const itemRows = serviceRequest.items.map((item) => {
    const lineTotal = Number(item.unitPrice || 0) * item.quantity;

    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #292929;color:#f4f1ed;">${escapeHtml(item.name)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #292929;color:#b8b3ad;text-align:center;">${item.quantity}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #292929;color:#b8b3ad;text-align:right;">${formatCad(item.unitPrice)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #292929;color:#f4f1ed;text-align:right;">${formatCad(lineTotal)}</td>
      </tr>
    `;
  }).join('');
  const adminNote = serviceRequest.adminNote
    ? `<div style="margin-top:18px;padding:18px;background:#121212;border-left:3px solid #c12a32;">
        <p style="margin:0 0 7px;color:#ef3939;font-size:11px;letter-spacing:1.5px;">MESSAGE FROM KHALIL</p>
        <p style="margin:0;line-height:1.6;color:#f4f1ed;">${escapeHtml(serviceRequest.adminNote).replaceAll('\n', '<br>')}</p>
      </div>`
    : '';

  return sendBrevoEmail({
    to: [{ email: serviceRequest.customerEmail, name: serviceRequest.customerName }],
    replyTo: {
      email: khalilEmail,
      name: 'Khalil Nahhat',
    },
    subject: 'Your DJ Khalil Nahhat service quote is ready',
    tags: ['service-quote'],
    htmlContent: `<!doctype html>
      <html>
        <body style="margin:0;background:#080808;color:#f4f1ed;font-family:Arial,sans-serif;">
          <div style="max-width:680px;margin:0 auto;padding:32px 20px;">
            <p style="margin:0 0 8px;color:#ef3939;font-size:12px;letter-spacing:2px;">KN// REQUESTED SERVICES</p>
            <h1 style="margin:0 0 12px;font-size:30px;">Your quote is ready</h1>
            <p style="margin:0 0 24px;color:#b8b3ad;line-height:1.6;">Hello ${escapeHtml(serviceRequest.customerName)}, Khalil has reviewed your service request and prepared the quote below.</p>
            <div style="padding:14px 18px;background:#121212;border:1px solid #292929;">
              <p style="margin:0;"><strong>Request:</strong> ${escapeHtml(serviceRequest.externalId)}</p>
            </div>
            <table style="width:100%;margin-top:18px;border-collapse:collapse;background:#121212;border:1px solid #292929;">
              <thead>
                <tr>
                  <th style="padding:10px 12px;text-align:left;color:#ef3939;">Service</th>
                  <th style="padding:10px 12px;text-align:center;color:#ef3939;">Qty</th>
                  <th style="padding:10px 12px;text-align:right;color:#ef3939;">Unit price</th>
                  <th style="padding:10px 12px;text-align:right;color:#ef3939;">Total</th>
                </tr>
              </thead>
              <tbody>${itemRows}</tbody>
            </table>
            <div style="padding:18px;background:#181818;text-align:right;border:1px solid #292929;border-top:0;">
              <span style="display:block;color:#b8b3ad;font-size:11px;letter-spacing:1.5px;">QUOTE TOTAL</span>
              <strong style="font-size:28px;color:#ef3939;">${formatCad(total)}</strong>
            </div>
            ${adminNote}
            ${customerServicesUrl ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(customerServicesUrl)}" style="display:inline-block;padding:12px 18px;background:#c12a32;color:#fff;text-decoration:none;">View Requested Services</a></p>` : ''}
            <p style="margin:24px 0 0;color:#777;font-size:12px;line-height:1.6;">Reply directly to this email if you have questions about your quote.</p>
          </div>
        </body>
      </html>`,
  });
}

async function sendLiveRequestReceipt({ email, requesterName, groupId, confirmationRequests, amountTotal, currency }) {
  const rows = confirmationRequests.map((request) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #292929;color:#f4f1ed;">${escapeHtml(request.track || request.message)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #292929;color:#ef3939;font-family:monospace;">${escapeHtml(request.confirmationCode)}</td>
    </tr>
  `).join('');
  const total = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: String(currency || 'CAD').toUpperCase(),
  }).format(Number(amountTotal || 0) / 100);

  return sendBrevoEmail({
    to: [{ email, name: requesterName || 'Audience' }],
    replyTo: {
      email: process.env.SERVICE_REQUEST_NOTIFICATION_EMAIL?.trim() || DEFAULT_NOTIFICATION_EMAIL,
      name: 'Khalil Nahhat',
    },
    subject: `Song request receipt ${groupId}`,
    tags: ['live-song-request', 'payment-receipt'],
    htmlContent: `<!doctype html>
      <html><body style="margin:0;background:#080808;color:#f4f1ed;font-family:Arial,sans-serif;">
        <div style="max-width:680px;margin:0 auto;padding:32px 20px;">
          <p style="margin:0 0 8px;color:#ef3939;font-size:12px;letter-spacing:2px;">KN// SONG REQUESTS</p>
          <h1 style="margin:0 0 12px;font-size:30px;">Payment confirmed</h1>
          <p style="margin:0 0 24px;color:#b8b3ad;line-height:1.6;">Hello ${escapeHtml(requesterName || 'Audience')}, your request payment was received. Khalil will review the songs for the live event.</p>
          <div style="padding:14px 18px;background:#121212;border:1px solid #292929;">
            <p style="margin:0 0 8px;"><strong>Group confirmation:</strong> ${escapeHtml(groupId)}</p>
            <p style="margin:0;"><strong>Total paid:</strong> ${escapeHtml(total)}</p>
          </div>
          <table style="width:100%;margin-top:18px;border-collapse:collapse;background:#121212;border:1px solid #292929;">
            <thead><tr><th style="padding:10px 12px;text-align:left;color:#ef3939;">Song request</th><th style="padding:10px 12px;text-align:left;color:#ef3939;">Confirmation code</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin:24px 0 0;color:#777;font-size:12px;line-height:1.6;">Keep this email if you need to reference your request codes.</p>
        </div>
      </body></html>`,
  });
}

module.exports = {
  sendLiveRequestReceipt,
  sendServiceQuoteNotification,
  sendServiceRequestNotification,
};
