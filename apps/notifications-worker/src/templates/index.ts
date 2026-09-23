/**
 * Static email templates for the notifications worker.
 *
 * Spec 14 allows V1 templates to be static files as long as template
 * versions remain traceable — these renderers are the V1 "static files"
 * form, keyed by the same `templateKey` strings the calling workers pass
 * to POST /v1/notifications.
 *
 * Every substitution is HTML-escaped before it reaches the html body, so a
 * hostile value in `templateData` (or a recipient-controlled field such as
 * an email hint) can never inject markup. Renderers only read the fields
 * they need; unknown extra fields are ignored, and unknown template keys
 * return null so the provider can fail the send with a bounded reason
 * instead of delivering an empty message.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export type TemplateData = Record<string, string | number | boolean | null>;

export interface TemplateRenderOptions {
  /**
   * Product display name used in subjects/footers (e.g. "Ackstack").
   * Falls back to neutral copy when not configured so a misconfigured
   * deployment still produces a sensible email.
   */
  brandName?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Stringify a templateData value; null/undefined render as "". */
function str(data: TemplateData, key: string): string {
  const v = data[key];
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * Render an ISO timestamp as a human-readable UTC string. Falls back to the
 * raw value when it does not parse — a slightly ugly email beats a failed
 * send.
 */
function formatTimestamp(raw: string): string {
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toUTCString();
}

/**
 * Shared shell so all transactional emails look consistent. Body fragments
 * passed in MUST already be escaped.
 */
function htmlShell(title: string, bodyHtml: string, footerLine: string): string {
  return [
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background-color:#f4f4f7;">',
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;color:#1a1a2e;">',
    '<div style="background:#ffffff;border-radius:8px;padding:32px;">',
    `<h1 style="margin:0 0 16px;font-size:20px;">${title}</h1>`,
    bodyHtml,
    "</div>",
    `<p style="margin:16px 0 0;font-size:12px;color:#6b6b80;text-align:center;">${footerLine}</p>`,
    "</div></body></html>",
  ].join("");
}

type TemplateRenderer = (data: TemplateData, opts: TemplateRenderOptions) => RenderedEmail;

const renderMagicLink: TemplateRenderer = (data, opts) => {
  const code = str(data, "code");
  const expires = formatTimestamp(str(data, "expiresAt"));
  const brand = opts.brandName ?? "";
  const subject = brand ? `Your ${brand} login code` : "Your login code";
  const expiryLineText = expires ? `This code expires at ${expires}.` : "This code expires shortly.";

  const text = [
    "Use this code to finish signing in:",
    "",
    code,
    "",
    expiryLineText,
    "If you did not request this code, you can safely ignore this email.",
  ].join("\n");

  const html = htmlShell(
    "Finish signing in",
    [
      '<p style="margin:0 0 16px;font-size:14px;">Use this code to finish signing in:</p>',
      `<p style="margin:0 0 16px;font-size:28px;font-weight:700;letter-spacing:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(code)}</p>`,
      `<p style="margin:0 0 8px;font-size:13px;color:#6b6b80;">${escapeHtml(expiryLineText)}</p>`,
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If you did not request this code, you can safely ignore this email.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated security email."),
  );

  return { subject, html, text };
};

const renderInvitationCreated: TemplateRenderer = (data, opts) => {
  const role = str(data, "role");
  const expires = formatTimestamp(str(data, "expiresAt"));
  const brand = opts.brandName ?? "";
  const subject = brand
    ? `You have been invited to an organization on ${brand}`
    : "You have been invited to an organization";
  const roleLineText = role
    ? `You have been invited to join an organization as ${role}.`
    : "You have been invited to join an organization.";
  const expiryLineText = expires ? `The invitation expires at ${expires}.` : "";

  const text = [
    roleLineText,
    expiryLineText,
    "Sign in with this email address to view and accept the invitation.",
    "If you were not expecting this invitation, you can safely ignore this email.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");

  const html = htmlShell(
    "You have been invited",
    [
      `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(roleLineText)}</p>`,
      expiryLineText
        ? `<p style="margin:0 0 16px;font-size:13px;color:#6b6b80;">${escapeHtml(expiryLineText)}</p>`
        : "",
      '<p style="margin:0 0 8px;font-size:14px;">Sign in with this email address to view and accept the invitation.</p>',
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If you were not expecting this invitation, you can safely ignore this email.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );

  return { subject, html, text };
};

const renderInvitationAccepted: TemplateRenderer = (data, opts) => {
  const role = str(data, "role");
  const brand = opts.brandName ?? "";
  const subject = brand ? `You have joined an organization on ${brand}` : "You have joined an organization";
  const bodyLineText = role
    ? `Your invitation was accepted and you are now a member with the ${role} role.`
    : "Your invitation was accepted and you are now a member of the organization.";

  const text = [
    bodyLineText,
    "If this was not you, contact your organization administrator.",
  ].join("\n\n");

  const html = htmlShell(
    "Welcome aboard",
    [
      `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(bodyLineText)}</p>`,
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If this was not you, contact your organization administrator.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );

  return { subject, html, text };
};

/**
 * AS2 — a request to acknowledge a policy. The link is the message (the
 * database keeps only its hash), so it travels in templateData the way the
 * login code does for auth.magic_link.
 */
function renderPolicyAcknowledgment(kind: "request" | "reminder"): TemplateRenderer {
  return (data, opts) => {
    const staffName = str(data, "staffName");
    const title = str(data, "policyTitle");
    const version = str(data, "version");
    const summary = str(data, "summary");
    const due = formatTimestamp(str(data, "dueAt"));
    const link = str(data, "link");
    const brand = opts.brandName ?? "";
    const subject =
      kind === "reminder"
        ? `Reminder: please acknowledge "${title}"`
        : `Please read and acknowledge "${title}"`;
    const greeting = staffName ? `Hi ${staffName},` : "Hello,";
    const ask =
      kind === "reminder"
        ? `This is a reminder that your employer still needs your acknowledgment of "${title}" (version ${version}).`
        : `Your employer has asked you to read and acknowledge "${title}" (version ${version}).`;
    const dueLine = due ? `Please acknowledge by ${due}.` : "";
    const noLogin = "No account or password is needed — the button opens the policy and records your acknowledgment.";

    const text = [
      greeting,
      ask,
      summary ? `Summary: ${summary}` : "",
      dueLine,
      `Open the policy: ${link}`,
      noLogin,
      "This link is personal to you. Please do not forward it.",
    ]
      .filter((line) => line.length > 0)
      .join("\n\n");

    const html = htmlShell(
      kind === "reminder" ? "A policy still needs your acknowledgment" : "Please acknowledge a policy",
      [
        `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(greeting)}</p>`,
        `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(ask)}</p>`,
        summary
          ? `<p style="margin:0 0 16px;font-size:14px;color:#3a3a4e;"><strong>Summary:</strong> ${escapeHtml(summary)}</p>`
          : "",
        dueLine ? `<p style="margin:0 0 16px;font-size:13px;color:#6b6b80;">${escapeHtml(dueLine)}</p>` : "",
        `<p style="margin:0 0 24px;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#1a1a2e;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px;">Read and acknowledge</a></p>`,
        `<p style="margin:0 0 8px;font-size:13px;color:#6b6b80;">${escapeHtml(noLogin)}</p>`,
        '<p style="margin:0;font-size:13px;color:#6b6b80;">This link is personal to you. Please do not forward it.</p>',
      ].join(""),
      escapeHtml(brand ? `Sent by ${brand} on behalf of your employer` : "Sent on behalf of your employer."),
    );

    return { subject, html, text };
  };
}

const TEMPLATES: Record<string, TemplateRenderer> = {
  "auth.magic_link": renderMagicLink,
  "invitation.created": renderInvitationCreated,
  "invitation.accepted": renderInvitationAccepted,
  "policy.acknowledgment_request": renderPolicyAcknowledgment("request"),
  "policy.acknowledgment_reminder": renderPolicyAcknowledgment("reminder"),
};

/**
 * Render the email for a template key, or null when the key has no
 * registered template. Callers (the provider adapters) MUST treat null as a
 * bounded send failure — never deliver an empty or generic body.
 */
export function renderEmailTemplate(
  templateKey: string,
  templateData: TemplateData,
  opts: TemplateRenderOptions = {},
): RenderedEmail | null {
  const renderer = TEMPLATES[templateKey];
  if (!renderer) return null;
  return renderer(templateData, opts);
}
