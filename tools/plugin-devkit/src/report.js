export class Report {
  constructor() {
    this.items = [];
  }

  error(message, detail) {
    this.items.push({ level: 'error', message, detail });
  }

  warn(message, detail) {
    this.items.push({ level: 'warning', message, detail });
  }

  info(message, detail) {
    this.items.push({ level: 'info', message, detail });
  }

  pass(message, detail) {
    this.items.push({ level: 'ok', message, detail });
  }

  get errorCount() {
    return this.items.filter(item => item.level === 'error').length;
  }

  get warningCount() {
    return this.items.filter(item => item.level === 'warning').length;
  }

  get ok() {
    return this.errorCount === 0;
  }

  toJSON() {
    return {
      ok: this.ok,
      errors: this.errorCount,
      warnings: this.warningCount,
      items: this.items
    };
  }
}

export function printReport(report) {
  const labels = {
    ok: 'OK',
    info: 'INFO',
    warning: 'WARN',
    error: 'ERROR'
  };

  for (const item of report.items) {
    const detail = item.detail === undefined ? '' : ` ${formatDetail(item.detail)}`;
    console.log(`[${labels[item.level] ?? item.level}] ${item.message}${detail}`);
  }
  console.log('');
  console.log(`Result: ${report.ok ? 'OK' : 'FAILED'} (${report.errorCount} errors, ${report.warningCount} warnings)`);
}

function formatDetail(detail) {
  if (typeof detail === 'string') return detail;
  return JSON.stringify(detail);
}
