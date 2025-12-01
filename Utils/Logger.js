export class Logger {
  static formatMessage(level, message, context) {
    const timestamp = new Date().toISOString();
    const base = `[${timestamp}] [${level}] ${message}`;
    if (!context) return base;
    try {
      return `${base} | ${typeof context === 'string' ? context : JSON.stringify(context)}`;
    } catch {
      return base;
    }
  }

  static info(message, context) {
    console.log(Logger.formatMessage('INFO', message, context));
  }

  static warn(message, context) {
    console.warn(Logger.formatMessage('WARN', message, context));
  }

  static error(message, context) {
    console.error(Logger.formatMessage('ERROR', message, context));
  }
}


