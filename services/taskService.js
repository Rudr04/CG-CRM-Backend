// ============================================================================
//  services/taskService.js — Cloud Tasks Scheduler
//
//  Schedules delayed HTTP callbacks to the same webhook endpoint.
//  Used for time-delayed follow-ups (3rd message, etc.)
// ============================================================================

const { CloudTasksClient } = require('@google-cloud/tasks');
const config = require('../config');

const client = new CloudTasksClient();
const LOG_PREFIX = '[Tasks]';


/**
 * Schedule a delayed POST to our own webhook.
 * @param {string} taskId   — Unique ID (prevents duplicates)
 * @param {object} payload  — JSON body (must include eventType for router)
 * @param {number} delaySec — Seconds from now
 */
async function scheduleWebhookTask(taskId, payload, delaySec) {
  const project  = config.CLOUD_TASKS.PROJECT_ID;
  const location = config.CLOUD_TASKS.LOCATION;
  const queue    = config.CLOUD_TASKS.QUEUE;
  const url      = config.CLOUD_TASKS.WEBHOOK_URL;

  const parent = client.queuePath(project, location, queue);

  const task = {
    name: `${parent}/tasks/${taskId}`,
    httpRequest: {
      httpMethod: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
    },
    scheduleTime: {
      seconds: Math.floor(Date.now() / 1000) + delaySec,
    },
  };

  try {
    await client.createTask({ parent, task });
    console.log(`${LOG_PREFIX} Scheduled '${taskId}' in ${delaySec}s`);
    return true;
  } catch (error) {
    if (error.code === 6) {
      console.log(`${LOG_PREFIX} Task '${taskId}' already exists — skipping`);
      return true;
    }
    console.error(`${LOG_PREFIX} Failed to schedule '${taskId}':`, error.message);
    return false;
  }
}


module.exports = { scheduleWebhookTask };