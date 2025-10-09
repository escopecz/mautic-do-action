/**
 * Logger utility for Mautic deployment
 */

export class Logger {
  private static logFile = '/var/log/setup-dc.log';
  
  static async init() {
    try {
      // Ensure log directory exists
      await Deno.mkdir('/var/log', { recursive: true }).catch(() => {
        // If we can't create /var/log, try current directory
        this.logFile = './setup-dc.log';
      });
      
      await Deno.writeTextFile(this.logFile, '');
      await Deno.chmod(this.logFile, 0o600);
    } catch (error: unknown) {
      // Fallback to console-only logging if file operations fail
      console.error('Log file initialization failed, using console-only logging:', error);
      this.logFile = ''; // Disable file logging
    }
  }
  
  static log(message: string, emoji = '📋') {
    const timestamp = new Date().toISOString();
    const logMessage = `${emoji} ${message}`;
    console.log(logMessage);
    
    // Also write to log file if available
    if (this.logFile) {
      try {
        Deno.writeTextFileSync(this.logFile, `[${timestamp}] ${logMessage}\n`, { append: true });
      } catch {
        // Ignore log file errors
      }
    }
  }
  
  static error(message: string) {
    this.log(message, '❌');
  }
  
  static success(message: string) {
    this.log(message, '✅');
  }
  
  static info(message: string) {
    this.log(message, 'ℹ️');
  }
  
  static warning(message: string) {
    this.log(message, '⚠️');
  }
}