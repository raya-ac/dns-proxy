/**
 * Logger - Structured logging system for the DNS proxy
 * Supports multiple log levels, file output, and console output
 */

const fs = require('fs');
const path = require('path');

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

class Logger {
  constructor(config = {}) {
    this.level = LOG_LEVELS[config.level] ?? LOG_LEVELS.info;
    this.logFile = config.file ? path.resolve(config.file) : null;
    this.consoleOutput = config.consoleOutput !== false;
    
    // Ensure log directory exists
    if (this.logFile) {
      const logDir = path.dirname(this.logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
    }
  }

  /**
   * Set log level dynamically
   */
  setLevel(level) {
    this.level = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  }

  /**
   * Format a log entry
   */
  _format(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  }

  /**
   * Write log to file and/or console
   */
  _write(level, message, meta = {}) {
    const formatted = this._format(level, message, meta);
    
    if (this.consoleOutput) {
      const outputFn = level === 'error' || level === 'warn' ? console.error : console.log;
      outputFn(formatted);
    }
    
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, formatted + '\n');
      } catch (err) {
        console.error(`Failed to write to log file: ${err.message}`);
      }
    }
  }

  /**
   * Check if message should be logged based on level
   */
  _shouldLog(level) {
    return LOG_LEVELS[level] <= this.level;
  }

  error(message, meta = {}) {
    if (this._shouldLog('error')) {
      this._write('error', message, meta);
    }
  }

  warn(message, meta = {}) {
    if (this._shouldLog('warn')) {
      this._write('warn', message, meta);
    }
  }

  info(message, meta = {}) {
    if (this._shouldLog('info')) {
      this._write('info', message, meta);
    }
  }

  debug(message, meta = {}) {
    if (this._shouldLog('debug')) {
      this._write('debug', message, meta);
    }
  }

  /**
   * Log a DNS query
   */
  logQuery(source, domain, queryType, route, responseIp, latencyMs) {
    this.info('DNS query', {
      source,
      domain,
      query_type: queryType,
      route,
      response_ip: responseIp,
      latency_ms: latencyMs
    });
  }

  /**
   * Log proxy request
   */
  logProxyRequest(method, host, path, statusCode, bytes, latencyMs) {
    this.info('Proxy request', {
      method,
      host,
      path,
      status: statusCode,
      bytes,
      latency_ms: latencyMs
    });
  }
}

// Default logger instance (will be configured by index.js)
let defaultLogger = new Logger({ consoleOutput: true });

/**
 * Configure the default logger
 */
function configure(config) {
  defaultLogger = new Logger(config);
  return defaultLogger;
}

/**
 * Get the default logger instance
 */
function getLogger() {
  return defaultLogger;
}

module.exports = {
  Logger,
  configure,
  getLogger,
  LOG_LEVELS
};
