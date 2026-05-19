// ============================================================================
//  handlers/dashboardHandler.js — Dashboard Data API
//
//  GET /dashboard-data?from=2026-01-01&to=2026-05-19
//
//  Queries Firestore 'leads' collection, extracts lead creation date from
//  history[0].at, returns simplified lead array for client-side aggregation.
//
//  INTEGRATION: Add to index.js webhook GET handler:
//    const { handleDashboardRequest } = require('./handlers/dashboardHandler');
//    // Inside functions.http('webhook', ...) :
//    if (req.method === 'GET' && req.path === '/dashboard-data') {
//      return handleDashboardRequest(req, res);
//    }
// ============================================================================

const { getDb } = require('../services/firestoreService');
const config = require('../config');

const LOG_PREFIX = '[Dashboard]';
const CONVERTED_STATUSES = config.CONVERTED_STATUSES || ['Admission Done', 'Seat Booked'];
const TZ = config.TIMEZONE || 'Asia/Kolkata';


/**
 * Parse ISO timestamp → { dateStr, hour (0-23), dayOfWeek (0=Sun..6=Sat) }
 * Respects IST timezone.
 */
function parseTimestamp(isoString) {
  if (!isoString) return null;
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return null;

    // Format in IST to get correct local date/hour/day
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
      weekday: 'short',
    }).formatToParts(d);

    const get = (type) => parts.find(p => p.type === type)?.value || '';

    const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
    const hour = parseInt(get('hour'), 10);
    const dayName = get('weekday'); // Mon, Tue, ...
    const dayOfWeek = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });

    return { dateStr, hour, dayOfWeek: dayName || dayOfWeek };
  } catch {
    return null;
  }
}


/**
 * Main handler — query Firestore, return lead summaries.
 */
async function handleDashboardRequest(req, res) {
  // ── CORS (if dashboard is served from a different origin) ──
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  try {
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        error: 'Missing required query params: from, to (YYYY-MM-DD)',
      });
    }

    // Build Firestore range using createdAt (indexed field).
    // history[0].at and createdAt are set to the same nowISO() in createLead,
    // so this is functionally equivalent to querying by history[0].at.
    const fromISO = `${from}T00:00:00+05:30`;
    const toISO   = `${to}T23:59:59+05:30`;

    console.log(`${LOG_PREFIX} Querying leads: ${from} → ${to}`);

    const db = getDb();
    const snapshot = await db.collection('leads')
      .where('createdAt', '>=', fromISO)
      .where('createdAt', '<=', toISO)
      .orderBy('createdAt', 'asc')
      .get();

    console.log(`${LOG_PREFIX} Found ${snapshot.size} leads`);

    const leads = [];

    snapshot.forEach((doc) => {
      const d = doc.data();

      // Extract date/time from history[0].at — the true lead creation timestamp
      const historyAt = (d.history && d.history.length > 0) ? d.history[0].at : d.createdAt;
      const parsed = parseTimestamp(historyAt);

      if (!parsed) return; // skip leads with unparseable timestamps

      leads.push({
        cgId:      d.cgId || '',
        date:      parsed.dateStr,
        hour:      parsed.hour,
        dayOfWeek: parsed.dayOfWeek,
        stage:     d.stage || d.pipelineStage || '',
        source:    d.source || '',
        agent:     d.agent || 'Not Assigned',
        status:    d.status || '',
        inquiry:   d.inquiry || '',
        product:   d.product || '',
        converted: CONVERTED_STATUSES.includes(d.status),
        channel:   (d.history && d.history[0]?.details?.channel) || d.channel || '',
      });
    });

    return res.status(200).json({
      success: true,
      count: leads.length,
      from,
      to,
      leads,
    });

  } catch (error) {
    console.error(`${LOG_PREFIX} Error:`, error);
    return res.status(500).json({ error: error.message });
  }
}


module.exports = { handleDashboardRequest };