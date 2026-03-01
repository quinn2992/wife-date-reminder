// send-reminders.js — GitHub Actions cron job
// Reads Firestore for wives/subscribers/config, checks for dates within
// 7 days, sends reminder emails via EmailJS REST API.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ── Firebase Admin init ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── Global holidays (must match index.html) ──
const GLOBAL_DATES = [
  { name: "Valentine's Day",           month: 2,  day: 14 },
  { name: "International Women's Day", month: 3,  day: 8  },
  { name: "Mother's Day",              month: 5,  day: 11 },
  { name: "Vietnamese Women's Day",    month: 10, day: 20 },
  { name: "Christmas",                 month: 12, day: 25 },
];

// ── Date helpers (mirrors front-end logic) ──
function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysUntilFixed(month, day) {
  const t = todayMidnight();
  let d = new Date(t.getFullYear(), month - 1, day);
  if (d < t) d = new Date(t.getFullYear() + 1, month - 1, day);
  return Math.round((d - t) / 86400000);
}

function daysUntil(dateStr) {
  // Handles both "MM-DD" (new) and "YYYY-MM-DD" (legacy) formats
  const t = todayMidnight();
  const parts = dateStr.split('-').map(Number);
  const m = parts.length === 3 ? parts[1] : parts[0];
  const d = parts.length === 3 ? parts[2] : parts[1];
  let dt = new Date(t.getFullYear(), m - 1, d);
  if (dt < t) dt = new Date(t.getFullYear() + 1, m - 1, d);
  return Math.round((dt - t) / 86400000);
}

// ── Build alerts for a specific subscriber ──
function buildAlertsForSubscriber(people, subscriberEmail, maxDays = 7) {
  const alerts = [];

  // Global holidays go to everyone
  for (const g of GLOBAL_DATES) {
    const d = daysUntilFixed(g.month, g.day);
    if (d <= maxDays) alerts.push({ label: g.name, days: d });
  }

  // Wife-specific dates only go to the husband who added her
  for (const p of people) {
    if (p.ownerEmail && p.ownerEmail.toLowerCase() !== subscriberEmail.toLowerCase()) continue;
    // If ownerEmail is not set (legacy data), include for everyone
    const all = [];
    if (p.birthday)    all.push({ label: `${p.name}'s Birthday`, val: p.birthday });
    if (p.anniversary) all.push({ label: `${p.name}'s Anniversary`, val: p.anniversary });
    if (Array.isArray(p.custom)) {
      for (const c of p.custom) all.push({ label: `${c.label} (${p.name})`, val: c.date });
    }
    for (const dt of all) {
      const d = daysUntil(dt.val);
      if (d <= maxDays) alerts.push({ label: dt.label, days: d });
    }
  }

  return alerts.sort((a, b) => a.days - b.days);
}

function formatAlertText(alerts) {
  if (!alerts.length) return '';
  return alerts.map(a => {
    const w = a.days === 0 ? 'TODAY' : a.days <= 3 ? `In ${a.days} day(s)` : `In ${a.days} days`;
    return `${w} -- ${a.label}`;
  }).join('\n');
}

// ── Send email via EmailJS REST API ──
async function sendEmailViaREST(toEmail, eventListText, cfg) {
  const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:  cfg.serviceId,
      template_id: cfg.templateId,
      user_id:     cfg.pubKey,
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email:   toEmail,
        from_name:  cfg.sender || 'Date Reminder',
        event_list: eventListText,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`EmailJS ${response.status}: ${body}`);
  }
}

// ── Main ──
async function main() {
  console.log(`[${new Date().toISOString()}] Starting daily reminder check...`);

  // Read email config from Firestore
  const cfgSnap = await db.collection('config').doc('emailConfig').get();
  if (!cfgSnap.exists) {
    console.log('  No email config found in Firestore. Exiting.');
    return;
  }
  const cfg = cfgSnap.data();
  if (!cfg.serviceId || !cfg.templateId || !cfg.pubKey) {
    console.log('  Email config incomplete (missing serviceId/templateId/pubKey). Exiting.');
    return;
  }

  // Read wives
  const wivesSnap = await db.collection('wives').get();
  const people = [];
  wivesSnap.forEach(doc => people.push(doc.data()));
  console.log(`  Found ${people.length} wives in Firestore`);

  // Read subscribers
  const subsSnap = await db.collection('subscribers').get();
  const subscribers = [];
  subsSnap.forEach(doc => subscribers.push(doc.data()));
  console.log(`  Found ${subscribers.length} subscriber(s)`);

  if (subscribers.length === 0) {
    console.log('  No subscribers. Done.');
    return;
  }

  // Send per-subscriber targeted emails
  let ok = 0, fail = 0, skipped = 0;
  for (const sub of subscribers) {
    const alerts = buildAlertsForSubscriber(people, sub.email, 7);
    if (alerts.length === 0) {
      console.log(`  ${sub.name}: no upcoming dates, skipping`);
      skipped++;
      continue;
    }
    const alertText = formatAlertText(alerts);
    console.log(`  ${sub.name}: ${alerts.length} alert(s)`);
    alertText.split('\n').forEach(l => console.log(`    ${l}`));
    try {
      await sendEmailViaREST(sub.email, alertText, cfg);
      console.log(`  Sent to ${sub.name} (${sub.email})`);
      ok++;
      await new Promise(r => setTimeout(r, 1100)); // EmailJS rate limit: 1 req/sec
    } catch (e) {
      console.error(`  Failed for ${sub.email}: ${e.message}`);
      fail++;
    }
  }

  console.log(`\n  Done. Sent: ${ok}, Skipped: ${skipped}, Failed: ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
