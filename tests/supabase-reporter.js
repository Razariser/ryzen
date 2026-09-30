const fs = require('fs');

const { SESSION_ID, API_URL, PW_REPORT_SECRET, RUN_URL } = process.env;

const post = (body) =>
  fetch(`${API_URL}/api/admin?action=qa-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-pw-secret': PW_REPORT_SECRET },
    body: JSON.stringify({ session_id: SESSION_ID, ...body }),
  }).catch((e) => console.error('report failed:', e.message));

const clean = (s = '') => s.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300);

class QaReporter {
  constructor() {
    this.totals = { total: 0, passed: 0, failed: 0 };
    this.queue = Promise.resolve(); // keeps events in order despite parallel tests
  }

  emit(body) {
    this.queue = this.queue.then(() => post(body));
  }

  onBegin() {
    this.emit({ event: 'start', run_url: RUN_URL });
  }

  onTestEnd(test, result) {
    if (result.status === 'skipped') return;
    if (result.status !== 'passed' && result.retry < test.retries) return; // will be retried

    const ok = result.status === 'passed';
    this.totals.total++;
    ok ? this.totals.passed++ : this.totals.failed++;

    const shot = result.attachments.find((a) => a.name === 'screenshot' && a.path);
    const screenshot = shot ? `data:image/png;base64,${fs.readFileSync(shot.path).toString('base64')}` : null;

    this.emit({
      event: 'step',
      step: {
        title: test.title.replace(/@\w+/g, '').trim(),
        status: ok ? 'passed' : 'failed',
        duration_ms: result.duration,
        error: ok ? null : clean(result.error?.message),
        screenshot,
      },
    });
  }

  async onEnd() {
    this.emit({ event: 'end', totals: this.totals });
    await this.queue;
  }
}

module.exports = QaReporter;
