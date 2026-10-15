type LogLevel = 'info' | 'warn' | 'error';

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta ?? {}),
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export function log(message: string, meta?: Record<string, unknown>): void {
  emit('info', message, meta);
}

export function warn(message: string, meta?: Record<string, unknown>): void {
  emit('warn', message, meta);
}

export function error(message: string, meta?: Record<string, unknown>): void {
  emit('error', message, meta);
}
